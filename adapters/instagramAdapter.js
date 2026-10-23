const fetch = require("node-fetch");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../app/events/socialEvent");

const DEFAULT_API_VERSION = "v26.0";
const DEFAULT_AUTH_MODE = "facebook_login";
const DEFAULT_BASE_URL = "https://graph.instagram.com";
const FACEBOOK_BASE_URL = "https://graph.facebook.com";
const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function normalizeAuthMode(value) {
  const mode = String(value || DEFAULT_AUTH_MODE).trim().toLowerCase();
  if (["facebook", "facebook_login", "fb"].includes(mode)) return "facebook_login";
  if (["instagram", "instagram_login", "ig"].includes(mode)) return "instagram_login";
  throw new Error(`Unsupported Instagram auth mode: ${mode}`);
}

function normalizeBaseUrl(value, authMode) {
  const fallback = authMode === "facebook_login" ? FACEBOOK_BASE_URL : DEFAULT_BASE_URL;
  return String(value || fallback).replace(/\/+$/, "");
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function safeMetaFailure(result) {
  if (result.transportError) {
    return { status: "failed", reason: "NETWORK_ERROR", code: null, items: [] };
  }
  if (!result.response?.ok || result.data?.error) {
    return {
      status: "failed",
      reason: "META_REJECTED",
      code: result.data?.error?.code || null,
      type: result.data?.error?.type || null,
      items: [],
    };
  }
  return null;
}

function createInstagramAdapter({
  accessToken,
  userId,
  username,
  linkedPageAccessToken,
  accountKey,
  authMode = DEFAULT_AUTH_MODE,
  apiVersion = DEFAULT_API_VERSION,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  accessToken = String(accessToken || "").trim();
  userId = String(userId || "").trim();
  username = normalizeUsername(username);
  linkedPageAccessToken = String(linkedPageAccessToken || "").trim();
  accountKey = String(accountKey || "instagram:default").trim().toLowerCase();
  authMode = normalizeAuthMode(authMode);
  apiVersion = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "");
  baseUrl = normalizeBaseUrl(baseUrl, authMode);

  let facebookPageAccessToken = null;
  let facebookInstagramUserId = null;
  let facebookResolution = null;

  function endpoint(path) {
    return `${baseUrl}/${apiVersion}/${String(path || "").replace(/^\/+/, "")}`;
  }

  function effectiveUserId() {
    return authMode === "facebook_login" && facebookInstagramUserId
      ? facebookInstagramUserId
      : userId;
  }

  function createDiagnostics() {
    return {
      pagesVisible: 0,
      pagesWithInstagram: 0,
      identityLookupAttempts: 0,
      identityLookupSuccesses: 0,
      pageTokenFallbackConfigured: Boolean(linkedPageAccessToken),
      pageTokenFallbackAttempted: false,
      pageTokenFallbackHasInstagram: false,
    };
  }

  function withDiagnostics(result, diagnostics) {
    return { ...result, diagnostics: { ...diagnostics } };
  }

  function shouldExposeAuthDiagnostics(auth) {
    return Boolean(auth?.diagnostics?.pageTokenFallbackAttempted);
  }

  function authMetadata(auth) {
    if (!shouldExposeAuthDiagnostics(auth)) return {};
    return {
      ...(auth?.resolution === "configured_page_token" ? { resolution: auth.resolution } : {}),
      diagnostics: { ...auth.diagnostics },
    };
  }

  function externalizeAuthFailure(auth) {
    const result = {
      status: "failed",
      reason: auth?.reason || "AUTH_RESOLUTION_FAILED",
      code: auth?.code || null,
      ...(auth?.type ? { type: auth.type } : {}),
    };
    if (shouldExposeAuthDiagnostics(auth)) result.diagnostics = { ...auth.diagnostics };
    return result;
  }

  function createCommentEvent(value = {}, { rootId = null, ingress = "webhook", webhookField = null } = {}) {
    const sourceId = value?.comment_id || value?.id;
    if (!sourceId) return null;
    const metadata = ingress === "webhook"
      ? { webhookField, targetUserId: effectiveUserId() || null }
      : { ingress: "polling", targetUserId: effectiveUserId() || null };
    return createSocialEvent({
      platform: "instagram",
      accountKey,
      type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
      sourceId,
      rootId: value?.media?.id || value?.media_id || rootId || null,
      parentId: value?.parent_id || null,
      text: value?.text || "",
      author: {
        id: value?.from?.id || value?.user?.id || null,
        username: value?.from?.username || value?.username || null,
      },
      surface: value?.media?.media_product_type || null,
      timestamp: value?.timestamp || null,
      metadata,
    });
  }

  function parseWebhook(body) {
    const events = [];
    if (body?.object && body.object !== "instagram") return events;

    const acceptedTargetIds = new Set([userId, facebookInstagramUserId].filter(Boolean));
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      const targetUserId = entry?.id ? String(entry.id) : null;
      if (!targetUserId || !acceptedTargetIds.has(targetUserId)) continue;

      const changes = Array.isArray(entry?.changes)
        ? entry.changes
        : entry?.field
          ? [{ field: entry.field, value: entry.value }]
          : [];

      for (const change of changes) {
        if (!["comments", "live_comments"].includes(change?.field)) continue;
        const event = createCommentEvent(change?.value, {
          ingress: "webhook",
          webhookField: change.field,
        });
        if (event) events.push(event);
      }
    }
    return events;
  }

  async function requestJson(url, options = {}, token = accessToken) {
    let response;
    try {
      response = await fetchImpl(url, {
        timeout: timeoutMs,
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      return { transportError: error, response: null, data: null };
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}
    return { transportError: null, response, data };
  }

  function cacheFacebookCredentials({ linkedId, pageToken, resolution, diagnostics }) {
    linkedId = String(linkedId || "").trim();
    pageToken = String(pageToken || "").trim();
    if (!linkedId) return withDiagnostics({ status: "failed", reason: "LINKED_IG_ID_MISSING", code: null }, diagnostics);
    if (!pageToken) return withDiagnostics({ status: "failed", reason: "PAGE_TOKEN_MISSING", code: null }, diagnostics);
    facebookPageAccessToken = pageToken;
    facebookInstagramUserId = linkedId;
    facebookResolution = resolution;
    return {
      status: "ok",
      token: facebookPageAccessToken,
      userId: facebookInstagramUserId,
      resolution: facebookResolution,
      diagnostics: { ...diagnostics },
    };
  }

  function cacheFacebookPage(page, resolution, diagnostics) {
    return cacheFacebookCredentials({
      linkedId: page?.instagram_business_account?.id,
      pageToken: page?.access_token,
      resolution,
      diagnostics,
    });
  }

  async function verifyLinkedUsername(linkedId, pageToken, diagnostics) {
    if (!username) return { status: "ok", usernameMatch: true };
    diagnostics.identityLookupAttempts += 1;
    const identityUrl = `${endpoint(encodeURIComponent(linkedId))}?fields=${encodeURIComponent("id,username")}`;
    const identityResult = await requestJson(identityUrl, { method: "GET" }, pageToken);
    const identityFailure = safeMetaFailure(identityResult);
    if (identityFailure) return identityFailure;
    diagnostics.identityLookupSuccesses += 1;
    return {
      status: "ok",
      usernameMatch: normalizeUsername(identityResult.data?.username) === username,
    };
  }

  async function resolveConfiguredPageTokenFallback(diagnostics) {
    if (!linkedPageAccessToken) return null;
    diagnostics.pageTokenFallbackAttempted = true;

    const pageResult = await requestJson(
      `${endpoint("me")}?fields=${encodeURIComponent("id,instagram_business_account")}`,
      { method: "GET" },
      linkedPageAccessToken
    );
    const pageFailure = safeMetaFailure(pageResult);
    if (pageFailure) {
      return withDiagnostics({
        status: "failed",
        reason: pageFailure.reason,
        code: pageFailure.code || null,
        type: pageFailure.type || null,
      }, diagnostics);
    }

    const linkedId = String(pageResult.data?.instagram_business_account?.id || "").trim();
    diagnostics.pageTokenFallbackHasInstagram = Boolean(linkedId);
    if (!linkedId) {
      return withDiagnostics({ status: "failed", reason: "PAGE_TOKEN_HAS_NO_LINKED_INSTAGRAM", code: null }, diagnostics);
    }

    const verified = await verifyLinkedUsername(linkedId, linkedPageAccessToken, diagnostics);
    if (verified.status !== "ok") {
      return withDiagnostics({
        status: "failed",
        reason: verified.reason || "PAGE_TOKEN_IDENTITY_LOOKUP_FAILED",
        code: verified.code || null,
        type: verified.type || null,
      }, diagnostics);
    }
    if (!verified.usernameMatch) {
      return withDiagnostics({ status: "failed", reason: "PAGE_TOKEN_INSTAGRAM_USERNAME_MISMATCH", code: null }, diagnostics);
    }

    return cacheFacebookCredentials({
      linkedId,
      pageToken: linkedPageAccessToken,
      resolution: "configured_page_token",
      diagnostics,
    });
  }

  async function resolveFacebookPageToken() {
    if (authMode !== "facebook_login") {
      return { status: "ok", token: accessToken, userId, resolution: "instagram_login" };
    }
    if (facebookPageAccessToken && facebookInstagramUserId) {
      return {
        status: "ok",
        token: facebookPageAccessToken,
        userId: facebookInstagramUserId,
        resolution: facebookResolution,
      };
    }

    const diagnostics = createDiagnostics();
    if (!accessToken || (!userId && !username)) {
      return withDiagnostics({ status: "failed", reason: "INVALID_CONFIG", code: null }, diagnostics);
    }

    const fields = "id,name,access_token,instagram_business_account";
    const url = `${endpoint("me/accounts")}?fields=${encodeURIComponent(fields)}&limit=100`;
    const result = await requestJson(url, { method: "GET" }, accessToken);
    const failure = safeMetaFailure(result);
    if (failure) {
      const fallback = await resolveConfiguredPageTokenFallback(diagnostics);
      if (fallback?.status === "ok") return fallback;
      return fallback || withDiagnostics({
        status: "failed",
        reason: failure.reason,
        code: failure.code || null,
        type: failure.type || null,
      }, diagnostics);
    }

    const pages = Array.isArray(result.data?.data) ? result.data.data : [];
    diagnostics.pagesVisible = pages.length;
    diagnostics.pagesWithInstagram = pages.filter(item => item?.instagram_business_account?.id).length;

    const exactIdPage = userId
      ? pages.find(item => String(item?.instagram_business_account?.id || "") === userId)
      : null;
    if (exactIdPage) return cacheFacebookPage(exactIdPage, "id_match", diagnostics);

    if (username) {
      let firstLookupFailure = null;

      for (const page of pages) {
        const linkedId = String(page?.instagram_business_account?.id || "").trim();
        const pageToken = String(page?.access_token || "").trim();
        if (!linkedId || !pageToken) continue;

        const verified = await verifyLinkedUsername(linkedId, pageToken, diagnostics);
        if (verified.status !== "ok") {
          if (!firstLookupFailure) firstLookupFailure = verified;
          continue;
        }
        if (verified.usernameMatch) {
          return cacheFacebookPage(page, "username_match", diagnostics);
        }
      }

      if (diagnostics.identityLookupAttempts > 0 && diagnostics.identityLookupSuccesses === 0 && firstLookupFailure) {
        const fallback = await resolveConfiguredPageTokenFallback(diagnostics);
        if (fallback?.status === "ok") return fallback;
        return fallback || withDiagnostics({
          status: "failed",
          reason: firstLookupFailure.reason,
          code: firstLookupFailure.code || null,
          type: firstLookupFailure.type || null,
        }, diagnostics);
      }
    }

    const fallback = await resolveConfiguredPageTokenFallback(diagnostics);
    if (fallback?.status === "ok") return fallback;
    if (fallback) return fallback;
    return withDiagnostics({ status: "failed", reason: "LINKED_PAGE_NOT_FOUND", code: null }, diagnostics);
  }

  async function getRuntimeAuth() {
    if (authMode === "facebook_login") return resolveFacebookPageToken();
    if (!accessToken || !userId) return { status: "failed", reason: "INVALID_CONFIG", code: null };
    return { status: "ok", token: accessToken, userId, resolution: "instagram_login" };
  }

  async function getAccountIdentity() {
    if (!accessToken || (authMode === "instagram_login" && !userId)) {
      return { status: "failed", reason: "INVALID_CONFIG", code: null };
    }

    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return externalizeAuthFailure(auth);

    const instagramLogin = authMode === "instagram_login";
    const fields = instagramLogin
      ? "id,user_id,username,account_type,media_count"
      : "id,username,media_count";
    const path = instagramLogin ? "me" : encodeURIComponent(auth.userId);
    const result = await requestJson(`${endpoint(path)}?fields=${encodeURIComponent(fields)}`, { method: "GET" }, auth.token);
    const failure = safeMetaFailure(result);
    if (failure) {
      return {
        status: "failed",
        reason: failure.reason,
        code: failure.code || null,
        type: failure.type || null,
        ...authMetadata(auth),
      };
    }

    const mediaCount = Number(result.data?.media_count);
    const id = result.data?.id ? String(result.data.id) : null;
    const returnedUserId = result.data?.user_id ? String(result.data.user_id) : null;
    return {
      status: "ok",
      ...authMetadata(auth),
      identity: {
        id,
        userId: returnedUserId || (authMode === "facebook_login" ? id : null),
        username: result.data?.username ? String(result.data.username) : null,
        accountType: result.data?.account_type ? String(result.data.account_type) : null,
        mediaCount: Number.isFinite(mediaCount) ? mediaCount : null,
      },
    };
  }

  async function listRecentMedia({ limit = 10 } = {}) {
    if (!accessToken || (authMode === "instagram_login" && !userId)) {
      return { status: "failed", reason: "INVALID_CONFIG", code: null, items: [] };
    }
    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return { ...externalizeAuthFailure(auth), items: [] };

    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const fields = "id,timestamp,media_product_type,comments_count";
    const url = `${endpoint(`${encodeURIComponent(auth.userId)}/media`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" }, auth.token);
    const failure = safeMetaFailure(result);
    if (failure) return { ...failure, ...authMetadata(auth) };
    return {
      status: "ok",
      ...authMetadata(auth),
      items: Array.isArray(result.data?.data) ? result.data.data : [],
    };
  }

  async function listComments(mediaId, { limit = 50 } = {}) {
    if (!accessToken || !mediaId) return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT", code: null, items: [] };
    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return { ...externalizeAuthFailure(auth), items: [] };

    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 50));
    const fields = "id,text,username,from,parent_id,timestamp,replies{id,text,username,from,parent_id,timestamp}";
    const url = `${endpoint(`${encodeURIComponent(mediaId)}/comments`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" }, auth.token);
    const failure = safeMetaFailure(result);
    if (failure) return { ...failure, ...authMetadata(auth) };

    const items = [];
    for (const comment of Array.isArray(result.data?.data) ? result.data.data : []) {
      items.push({ ...comment, media: comment?.media || { id: String(mediaId) } });
      for (const reply of Array.isArray(comment?.replies?.data) ? comment.replies.data : []) {
        items.push({
          ...reply,
          parent_id: reply?.parent_id || comment?.id || null,
          media: reply?.media || { id: String(mediaId) },
        });
      }
    }
    return { status: "ok", ...authMetadata(auth), items };
  }

  function normalizePolledComment(comment, mediaId) {
    return createCommentEvent(comment, {
      rootId: mediaId,
      ingress: "polling",
      webhookField: null,
    });
  }

  async function getComment(commentId) {
    if (!accessToken || !commentId) return null;
    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return null;

    const fields = "id,text,username,from,parent_id,media,timestamp";
    const url = `${endpoint(encodeURIComponent(commentId))}?fields=${encodeURIComponent(fields)}`;
    const result = await requestJson(url, { method: "GET" }, auth.token);
    if (result.transportError || !result.response?.ok || result.data?.error) return null;
    return result.data || null;
  }

  async function reply(parentCommentId, message) {
    if (!accessToken || !parentCommentId || !String(message || "").trim()) {
      return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT" };
    }

    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") {
      const failure = externalizeAuthFailure(auth);
      return { status: "failed", reason: failure.reason, code: failure.code || null };
    }

    const body = new URLSearchParams({ message: String(message) });
    const result = await requestJson(endpoint(`${encodeURIComponent(parentCommentId)}/replies`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, auth.token);

    if (result.transportError) return { status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" };
    if (result.response.status >= 500) return { status: "ambiguous", reason: "SERVER_OUTCOME_UNKNOWN" };
    if (!result.response.ok || result.data?.error) {
      return {
        status: "failed",
        reason: "META_REJECTED",
        code: result.data?.error?.code || null,
      };
    }

    const id = result.data?.id || null;
    if (!id) return { status: "ambiguous", reason: "MISSING_PUBLISHED_ID" };
    return { status: "published", id: String(id) };
  }

  return {
    parseWebhook,
    getAccountIdentity,
    listRecentMedia,
    listComments,
    normalizePolledComment,
    getComment,
    reply,
    config: Object.freeze({ apiVersion, baseUrl, authMode }),
  };
}

module.exports = {
  DEFAULT_API_VERSION,
  DEFAULT_AUTH_MODE,
  DEFAULT_BASE_URL,
  FACEBOOK_BASE_URL,
  createInstagramAdapter,
};
