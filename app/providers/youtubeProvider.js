const { createSocialEvent, SOCIAL_EVENT_TYPES } = require("../events/socialEvent");
const { providerCapabilities } = require("./socialProvider");
const { createCommentCompatibility } = require("./commentCompatibility");
const { createYouTubeTokenManager, youtubeError, safeYouTubeReason, mapYouTubeError } = require("./youtubeTokenManager");
const { createYouTubeQuotaStore } = require("./youtubeQuotaStore");

const API_BASE = "https://www.googleapis.com/youtube/v3/";
const IDENTITY_MAX_AGE_MS = 5 * 60000;
const string = value => typeof value === "string" && value.trim() ? value.trim() : null;
const maxResults = value => Math.min(100, Math.max(1, Math.floor(Number(value) || 100)));

function validComment(comment) {
  const snippet = comment?.snippet;
  return Boolean(string(comment?.id) && snippet && typeof snippet === "object"
    && (typeof snippet.textOriginal === "string" || typeof snippet.textDisplay === "string"));
}

function createYouTubeProvider({
  account, env = process.env, fetchImpl = globalThis.fetch, tokenManager,
  quotaStore, clock = () => Date.now(), timeoutMs = 20000, requiredChannelId = null,
} = {}) {
  if (!account || account.platform !== "youtube") throw new Error("YouTube account config is required");
  const channelId = string(account.channelId) || string(account.userId);
  const envChannelId = string(env.YOUTUBE_CHANNEL_ID);
  const pinConflict = Boolean((envChannelId && envChannelId !== channelId) || (requiredChannelId && requiredChannelId !== channelId));
  const tokens = tokenManager || createYouTubeTokenManager({ env, fetchImpl, clock, timeoutMs });
  const quota = quotaStore || createYouTubeQuotaStore({ env, clock });
  let identity = null;
  let identityAt = null;
  let identityGeneration = null;
  let identityToken = null;
  let identityFlight = null;
  let lastError = null;

  function failure(error, fallback) {
    lastError = safeYouTubeReason(error, fallback);
    return { status: "failed", reason: lastError, ...(Number.isInteger(error?.status) ? { code: error.status } : {}), items: [] };
  }

  function assertConfigured() {
    if (account.enabled === false) throw youtubeError("MODULE_DISABLED");
    if (!channelId) throw youtubeError("CHANNEL_PIN_MISSING");
    if (pinConflict) throw youtubeError("AUTH_CHANNEL_MISMATCH");
  }

  function identityFresh(token) {
    return Boolean(identity?.id === channelId && identityAt !== null
      && clock() - identityAt < IDENTITY_MAX_AGE_MS
      && (token === undefined || identityToken === token)
      && identityGeneration === (tokens.getGeneration?.() ?? 0)
      && tokens.health?.().tokenReady !== false);
  }

  async function reserveRead() {
    let result;
    try {
      if (quota.isReady?.() === false && typeof quota.init === "function") await quota.init();
      result = await quota.reserve({ operation: "read", units: 1 });
    }
    catch (_) { throw youtubeError("QUOTA_STORE_ERROR"); }
    if (!(result?.ok === true || result?.status === "ok")) throw youtubeError(safeYouTubeReason(result, "QUOTA_STORE_UNAVAILABLE"));
  }

  // Only GET Data API transport exists in Gate 1–3. No generic mutation method
  // or comments.insert endpoint can be enabled by environment/consent flags.
  async function get(path, params, token) {
    await reserveRead();
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetchImpl(url.toString(), { method: "GET", redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${token}` } });
      } catch (_) { throw youtubeError("NETWORK_ERROR"); }
      let data;
      try { data = await response.json(); } catch (_) { throw youtubeError("MALFORMED_API_RESPONSE"); }
      if (!response.ok || data?.error) {
        if (response.status === 401) { tokens.invalidate?.(); identity = null; }
        throw mapYouTubeError(response.status, data);
      }
      if (!data || !Array.isArray(data.items) || (data.nextPageToken != null && typeof data.nextPageToken !== "string")) throw youtubeError("MALFORMED_API_RESPONSE");
      return { status: "ok", items: data.items, nextPageToken: data.nextPageToken || null };
    } finally { clearTimeout(timer); }
  }

  async function probeIdentity(token, { force = false } = {}) {
    if (!force && identityFresh(token)) return { status: "ok", identity: { ...identity }, channelId, idMatch: true };
    if (identityFlight) {
      await identityFlight;
      if (identityFresh(token)) return { status: "ok", identity: { ...identity }, channelId, idMatch: true };
    }
    const generation = tokens.getGeneration?.() ?? 0;
    identityFlight = (async () => {
      try {
        const result = await get("channels", { part: "id,snippet", mine: "true", maxResults: 50 }, token);
        // Ambiguous/multiple identities and extra pages must never become a
        // successful ASAP pin simply because one returned item happens to match.
        if (result.items.length !== 1 || result.nextPageToken || result.items[0]?.id !== channelId) throw youtubeError("AUTH_CHANNEL_MISMATCH");
        identity = { id: channelId, name: string(result.items[0]?.snippet?.title) };
        identityAt = clock();
        identityGeneration = generation;
        identityToken = token;
        lastError = null;
        return { status: "ok", identity: { ...identity }, channelId, idMatch: true };
      } catch (error) {
        identity = null;
        identityAt = null;
        identityGeneration = null;
        identityToken = null;
        throw error;
      }
    })().finally(() => { identityFlight = null; });
    return identityFlight;
  }

  async function getAccountIdentity({ force = false } = {}) {
    try {
      assertConfigured();
      const token = await tokens.getAccessToken();
      return await probeIdentity(token, { force });
    } catch (error) { return failure(error); }
  }

  async function read(path, params) {
    assertConfigured();
    const token = await tokens.getAccessToken();
    await probeIdentity(token);
    const result = await get(path, params, token);
    lastError = null;
    return result;
  }

  async function listCommentThreads({ pageToken = null, maxResults: limit = 100 } = {}) {
    try {
      if (pageToken !== null && typeof pageToken !== "string") throw youtubeError("INVALID_INPUT");
      const result = await read("commentThreads", {
        part: "snippet,replies", allThreadsRelatedToChannelId: channelId, order: "time",
        maxResults: maxResults(limit), textFormat: "plainText", moderationStatus: "published", pageToken,
      });
      for (const thread of result.items) {
        if (!string(thread?.id) || !validComment(thread?.snippet?.topLevelComment)
            || !Number.isSafeInteger(thread?.snippet?.totalReplyCount) || thread.snippet.totalReplyCount < 0
            || (thread.replies != null && !Array.isArray(thread.replies.comments))
            || (thread.replies?.comments || []).some(comment => !validComment(comment))) throw youtubeError("MALFORMED_API_RESPONSE");
        if (thread.snippet.channelId && thread.snippet.channelId !== channelId) throw youtubeError("AUTH_CHANNEL_MISMATCH");
      }
      return result;
    } catch (error) { return failure(error); }
  }

  async function listReplies(parentTopLevelCommentId, { pageToken = null, maxResults: limit = 100 } = {}) {
    try {
      const parentId = string(parentTopLevelCommentId);
      if (!parentId || (pageToken !== null && typeof pageToken !== "string")) throw youtubeError("INVALID_INPUT");
      const result = await read("comments", { part: "snippet", parentId, textFormat: "plainText", maxResults: maxResults(limit), pageToken });
      if (result.items.some(comment => !validComment(comment) || comment.snippet.parentId !== parentId)) throw youtubeError("MALFORMED_API_RESPONSE");
      return result;
    } catch (error) { return failure(error); }
  }

  async function listAllReplies(parentTopLevelCommentId, { maxPages = 100, maxResults: limit = 100 } = {}) {
    const pageLimit = Math.min(1000, Math.max(1, Math.floor(Number(maxPages) || 100)));
    const items = [];
    const seenTokens = new Set();
    let pageToken = null;
    for (let page = 0; page < pageLimit; page += 1) {
      const result = await listReplies(parentTopLevelCommentId, { pageToken, maxResults: limit });
      if (result.status !== "ok") return result; // Never expose a partial set as complete.
      items.push(...result.items);
      pageToken = result.nextPageToken;
      if (!pageToken) return { status: "ok", items, nextPageToken: null, complete: true };
      if (seenTokens.has(pageToken)) return failure(youtubeError("PAGINATION_LOOP"));
      seenTokens.add(pageToken);
    }
    return failure(youtubeError("PAGINATION_LIMIT"));
  }

  function normalizePolledComment(input, context = {}) {
    const thread = input?.snippet?.topLevelComment ? input : null;
    const comment = thread ? thread.snippet.topLevelComment : input;
    if (!validComment(comment)) return null;
    const snippet = comment.snippet;
    if (snippet.parentId && context.topLevelCommentId && snippet.parentId !== context.topLevelCommentId) return null;
    const sourceId = string(comment.id);
    const topLevelCommentId = string(context.topLevelCommentId) || string(snippet.parentId) || sourceId;
    const isTopLevel = context.isTopLevel !== false && !snippet.parentId && sourceId === topLevelCommentId;
    const videoId = string(context.videoId) || string(thread?.snippet?.videoId) || string(snippet.videoId);
    const authorChannelId = string(snippet.authorChannelId?.value);
    const authorDisplayName = string(snippet.authorDisplayName);
    const creatorReplied = context.creatorReplied === true || context.creatorAnswered === true;
    return createSocialEvent({
      platform: "youtube", accountKey: account.key, type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
      sourceId, rootId: videoId, parentId: isTopLevel ? videoId : topLevelCommentId,
      text: typeof snippet.textOriginal === "string" ? snippet.textOriginal : snippet.textDisplay,
      author: { id: authorChannelId, username: authorDisplayName }, surface: "YOUTUBE_COMMENTS",
      timestamp: string(snippet.publishedAt),
      metadata: {
        ingress: "polling", channelId, topLevelCommentId, videoId,
        videoTitle: string(context.videoTitle), threadId: string(context.threadId) || string(thread?.id),
        authorChannelId, authorDisplayName, isTopLevel, isReply: !isTopLevel,
        creatorReplied, creatorAnswered: creatorReplied, contextComplete: context.contextComplete === true,
        totalReplyCount: Number.isSafeInteger(context.totalReplyCount) ? context.totalReplyCount : (thread?.snippet?.totalReplyCount ?? null),
      },
    });
  }

  async function reply() { return { status: "failed", reason: "LIVE_TRANSPORT_DISABLED" }; }
  const provider = {
    platform: "youtube", accountKey: account.key, account, channelId,
    capabilities: providerCapabilities({ webhooks: false, publishReplies: false }),
    parseWebhook: () => [], normalizeWebhookEvent: () => null,
    getAccountIdentity, listCommentThreads, listReplies, listAllReplies, normalizePolledComment,
    reply, publishReply: reply,
    health() {
      const auth = tokens.health?.() || { configured: false, tokenReady: false, writeScopeReady: false };
      return {
        platform: "youtube", accountKey: account.key, enabled: Boolean(account.enabled),
        configured: Boolean(channelId && !pinConflict && auth.configured), channelId, channelPin: channelId,
        requiredChannelId, channelPinMatchesTarget: !pinConflict,
        identityVerified: identityFresh(), identity: identity ? { ...identity } : null,
        identityCheckedAt: identityAt !== null ? new Date(identityAt).toISOString() : null,
        auth, writeScopeReady: auth.writeScopeReady === true, dryRun: true,
        mode: account.enabled === false || String(env.YOUTUBE_REPLY_MODE || "").toUpperCase() === "OFF" ? "OFF" : "DRAFT_ONLY",
        liveTransportEnabled: false, quota: quota.health?.() || null, lastError,
      };
    },
    async close() { if (!quotaStore) await quota.close?.(); },
  };
  return Object.assign(provider, createCommentCompatibility({ adapter: provider, account, platform: "youtube" }));
}

module.exports = { createYouTubeProvider };
