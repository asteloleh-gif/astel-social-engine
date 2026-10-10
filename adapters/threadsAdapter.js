const fetch = require("node-fetch");
const { createThreadsTokenManager } = require("../auth/threadsTokenManager");
const { createSafeReplyPublisher } = require("./threadsReplyPublisher");

const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function sanitizeMetaError(error) {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;

  const redact = (value) => {
    if (typeof value !== "string") return value;
    return value
      .replace(/(access_token=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
      .slice(0, 1000);
  };

  const allowed = {
    message: redact(error.message),
    type: redact(error.type),
    code: error.code ?? null,
    error_subcode: error.error_subcode ?? null,
    error_user_title: redact(error.error_user_title),
    error_user_msg: redact(error.error_user_msg),
    fbtrace_id: redact(error.fbtrace_id),
  };

  return Object.fromEntries(
    Object.entries(allowed).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function createThreadsAdapter({ accessToken, userId }) {
  // Backward-compatible fallback for the existing Railway typo. Prefer THREADS_ACCESS_TOKEN,
  // but accept THREDS_ACCESS_TOKEN so the current sealed value can be used without exposing it.
  accessToken = accessToken || process.env.THREDS_ACCESS_TOKEN || "";
  const tokenManager = createThreadsTokenManager({ initialToken: accessToken, redisUrl: process.env.REDIS_URL });
  // Only auto-connect when the real server is the process entrypoint. Tests import the adapter/server
  // and must not leave an open Redis socket that blocks Railway pre-deploy completion.
  if (require.main?.filename?.endsWith("server.js")) {
    tokenManager.init().catch(e => console.error("Threads token manager init failed", e?.message || String(e)));
  }
  const getAccessToken = () => tokenManager.getToken() || accessToken;

  async function fetchWithRetry(url, options, maxAttempts = 3) {
    const opts = { timeout: DEFAULT_FETCH_TIMEOUT_MS, ...options };
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, opts);
        if (res.status !== 429 && res.status < 500) return res;
        if (attempt === maxAttempts) return res;
      } catch (e) {
        lastErr = e;
        if (attempt === maxAttempts) throw e;
      }
      const backoff = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
    throw lastErr;
  }

  function withWebhookTarget(value, targetId) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !targetId) return value;
    return { ...value, __webhook_target_id: String(targetId) };
  }

  function parseWebhook(body) {
    const events = [];
    const values = Array.isArray(body?.values) ? body.values : [];
    const envelopeTargetId = body?.target_id || null;
    for (const item of values) {
      if (!["replies", "comments"].includes(item?.field)) continue;
      if (item?.value) events.push(withWebhookTarget(item.value, item?.target_id || envelopeTargetId));
    }
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        if (!["replies", "comments"].includes(change?.field)) continue;
        if (change?.value) events.push(withWebhookTarget(change.value, change?.target_id || entry?.target_id || envelopeTargetId));
      }
    }
    return events;
  }

  function getAuthorId(c) { return c?.user_id || c?.from?.id || c?.user?.id || c?.owner_id || null; }
  function getAuthorUsername(c) { return c?.username || c?.from?.username || c?.user?.username || null; }
  function getCommentId(c) { return c?.id || c?.reply_id || c?.media?.id || null; }
  function getCommentText(c) { return c?.text || c?.reply_text || c?.media?.text || null; }
  function getParentId(c) { return c?.replied_to?.id || c?.parent?.id || c?.parent_id || null; }
  function getParentAuthorId(c) { return c?.replied_to?.user_id || c?.replied_to?.from?.id || c?.parent?.user_id || c?.parent?.from?.id || c?.parent_user_id || null; }
  function getParentAuthorUsername(c) { return c?.replied_to?.username || c?.replied_to?.from?.username || c?.parent?.username || c?.parent?.from?.username || c?.parent_username || null; }
  function getWebhookTargetId(c) { return c?.__webhook_target_id || null; }
  function getRootPostId(c) { return c?.root_post?.id || c?.root_post_id || c?.media_id || c?.media?.root_post?.id || getParentId(c) || null; }

  async function resolveParentAuthor(c, { ownerUsername, ownerUserId, lookupEnabled = true } = {}) {
    const parentId = getParentId(c), rootId = getRootPostId(c);
    const payloadAuthorId = getParentAuthorId(c), payloadUsername = getParentAuthorUsername(c);
    if (!parentId) return { parentId: null, parentAuthorId: null, parentAuthorUsername: null, source: "none" };
    if (payloadAuthorId || payloadUsername) return { parentId, parentAuthorId: payloadAuthorId, parentAuthorUsername: payloadUsername, source: "webhook" };
    if (rootId && String(parentId) === String(rootId)) return { parentId, parentAuthorId: ownerUserId || userId || null, parentAuthorUsername: ownerUsername || null, source: "root-owner" };
    const token = getAccessToken();
    if (!lookupEnabled || !token) return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "unknown" };
    try {
      const fields = "id,username,user_id";
      const url = `https://graph.threads.net/v1.0/${encodeURIComponent(parentId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
      const res = await fetchWithRetry(url, { method: "GET" }, 2);
      let data = null; try { data = await res.json(); } catch (_) {}
      if (!res.ok || data?.error) {
        console.warn("Threads parent lookup failed", JSON.stringify({ parentId: String(parentId), status: res.status, code: data?.error?.code || null }));
        return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "lookup-failed" };
      }
      return { parentId, parentAuthorId: data?.user_id || null, parentAuthorUsername: data?.username || null, source: "api" };
    } catch (e) {
      console.warn("Threads parent lookup error", JSON.stringify({ parentId: String(parentId), error: e?.message || String(e) }));
      return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "lookup-error" };
    }
  }

  async function createReply(parentCommentId, message) {
    const token = getAccessToken();
    if (!token || !userId) { console.error("Threads config error: access token or user id missing"); return null; }
    const createParams = new URLSearchParams({ media_type: "TEXT", text: message, reply_to_id: String(parentCommentId), access_token: token });
    let createRes;
    try { createRes = await fetchWithRetry(`https://graph.threads.net/v1.0/me/threads?${createParams}`, { method: "POST" }); }
    catch (e) { console.error("Threads container creation network error:", e?.message || String(e)); return null; }
    let createData; try { createData = await createRes.json(); } catch (_) { console.error("Threads container creation error: unparseable response", createRes.status); return null; }
    if (!createRes.ok || createData.error) {
      console.error("Threads container creation error", JSON.stringify({
        status: createRes.status,
        parentCommentId: String(parentCommentId),
        error: sanitizeMetaError(createData?.error),
      }));
      return null;
    }
    const creationId = createData.id;
    if (!creationId) { console.error("Threads container creation error: missing creation id"); return null; }
    console.log("Threads reply container created", JSON.stringify({ id: creationId })); return creationId;
  }

  const safeReplyPublisher = createSafeReplyPublisher({ getAccessToken, userId });

  async function publishReply(creationId) {
    return safeReplyPublisher.publishReply(creationId);
  }

  async function reply(parentCommentId, message) {
    const creationId = await createReply(parentCommentId, message);
    if (!creationId) return { status: "failed" };
    return publishReply(creationId);
  }

  return { parseWebhook, getAuthorId, getAuthorUsername, getRootPostId, getCommentId, getCommentText, getParentId, getParentAuthorId, getParentAuthorUsername, getWebhookTargetId, resolveParentAuthor, createReply, publishReply, reply, tokenManager };
}

module.exports = { createThreadsAdapter, sanitizeMetaError };
