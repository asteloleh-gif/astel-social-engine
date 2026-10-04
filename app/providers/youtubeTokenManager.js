// Existing-grant refresh only: no authorization-code flow, credential persistence,
// scope expansion, or account setup belongs in this Gate 1–3 module.
const YOUTUBE_FORCE_SSL_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SAFE_REASONS = new Set([
  "AUTH_CONFIG_MISSING", "AUTH_REFRESH_FAILED", "AUTH_REVOKED", "AUTH_SCOPE_MISSING",
  "AUTH_TOKEN_MALFORMED", "AUTH_CHANNEL_MISMATCH", "AUTH_REQUIRED", "CHANNEL_PIN_MISSING",
  "COMMENTS_DISABLED", "INSUFFICIENT_PERMISSIONS", "QUOTA_EXCEEDED", "RATE_LIMITED",
  "NOT_FOUND", "NETWORK_ERROR", "API_REJECTED", "API_UNAVAILABLE", "MALFORMED_API_RESPONSE",
  "QUOTA_STORE_UNAVAILABLE", "QUOTA_STORE_ERROR", "QUOTA_BUDGET_EXCEEDED", "LIVE_REPLY_CAP",
  "INVALID_QUOTA_REQUEST", "INVALID_INPUT", "PAGINATION_LIMIT", "PAGINATION_LOOP", "MODULE_DISABLED",
]);

function youtubeError(reason, status) {
  const safeReason = SAFE_REASONS.has(reason) ? reason : "API_REJECTED";
  const error = new Error(safeReason);
  error.code = safeReason;
  error.reason = safeReason;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}

function safeYouTubeReason(error, fallback = "API_REJECTED") {
  const reason = error?.reason || error?.code;
  return SAFE_REASONS.has(reason) ? reason : (SAFE_REASONS.has(fallback) ? fallback : "API_REJECTED");
}

function mapYouTubeError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason;
  const mapping = {
    commentsDisabled: "COMMENTS_DISABLED",
    insufficientPermissions: "INSUFFICIENT_PERMISSIONS",
    forbidden: "INSUFFICIENT_PERMISSIONS",
    quotaExceeded: "QUOTA_EXCEEDED",
    dailyLimitExceeded: "QUOTA_EXCEEDED",
    rateLimitExceeded: "RATE_LIMITED",
    userRateLimitExceeded: "RATE_LIMITED",
    authError: "AUTH_REQUIRED",
    invalidCredentials: "AUTH_REQUIRED",
    channelNotFound: "NOT_FOUND",
    commentNotFound: "NOT_FOUND",
    commentThreadNotFound: "NOT_FOUND",
    videoNotFound: "NOT_FOUND",
  };
  return youtubeError(Object.prototype.hasOwnProperty.call(mapping, reason) ? mapping[reason]
    : status === 401 ? "AUTH_REQUIRED"
    : status === 403 ? "INSUFFICIENT_PERMISSIONS"
    : status === 404 ? "NOT_FOUND"
    : status === 429 ? "RATE_LIMITED"
    : status >= 500 ? "API_UNAVAILABLE" : "API_REJECTED", status);
}

function createYouTubeTokenManager({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now(), timeoutMs = 20000 } = {}) {
  // Read secrets only from the runtime environment, never from account records.
  const clientId = String(env.YOUTUBE_CLIENT_ID || "").trim();
  const clientSecret = String(env.YOUTUBE_CLIENT_SECRET || "").trim();
  const refreshToken = String(env.YOUTUBE_REFRESH_TOKEN || "").trim();
  let accessToken = null;
  let expiresAt = 0;
  let scopes = new Set();
  let generation = 0;
  let inFlight = null;
  let lastError = null;

  function isConfigured() { return Boolean(clientId && clientSecret && refreshToken); }
  function valid() { return Boolean(accessToken && clock() < expiresAt - 30000); }

  async function refresh() {
    if (!isConfigured()) { lastError = "AUTH_CONFIG_MISSING"; throw youtubeError(lastError); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetchImpl(TOKEN_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
        });
      } catch (_) { throw youtubeError("NETWORK_ERROR"); }
      let data;
      try { data = await response.json(); } catch (_) { throw youtubeError("AUTH_TOKEN_MALFORMED"); }
      if (!response.ok || data?.error) {
        throw youtubeError(data?.error === "invalid_grant" ? "AUTH_REVOKED" : "AUTH_REFRESH_FAILED", response.status);
      }
      if (typeof data?.access_token !== "string" || !data.access_token.trim() || /[\r\n]/.test(data.access_token)
          || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 30 || Number(data.expires_in) > 86400
          || String(data.token_type || "").toLowerCase() !== "bearer") {
        throw youtubeError("AUTH_TOKEN_MALFORMED");
      }
      accessToken = data.access_token;
      expiresAt = clock() + Number(data.expires_in) * 1000;
      // Only a server-confirmed grant is evidence of scope readiness. Missing
      // scope never inherits an env assertion or the previous token's grant.
      scopes = new Set(typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : []);
      generation += 1;
      lastError = null;
      return accessToken;
    } catch (error) {
      accessToken = null;
      expiresAt = 0;
      scopes = new Set();
      lastError = safeYouTubeReason(error, "AUTH_REFRESH_FAILED");
      throw youtubeError(lastError, error?.status);
    } finally { clearTimeout(timer); }
  }

  async function getAccessToken({ force = false } = {}) {
    if (!force && valid()) return accessToken;
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function preflight({ forWrite = false } = {}) {
    try {
      await getAccessToken();
      if (forWrite && !scopes.has(YOUTUBE_FORCE_SSL_SCOPE)) return { status: "failed", reason: "AUTH_SCOPE_MISSING", writeScopeReady: false };
      return { status: "ok", writeScopeReady: scopes.has(YOUTUBE_FORCE_SSL_SCOPE) };
    } catch (error) { return { status: "failed", reason: safeYouTubeReason(error), writeScopeReady: false }; }
  }

  function invalidate() { accessToken = null; expiresAt = 0; scopes = new Set(); }
  function health() {
    return {
      configured: isConfigured(), tokenReady: valid(),
      writeScopeReady: valid() && scopes.has(YOUTUBE_FORCE_SSL_SCOPE),
      scopeVerified: valid() && scopes.size > 0,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      lastError,
    };
  }

  return { getAccessToken, preflight, invalidate, isConfigured, health, getGeneration: () => generation };
}

module.exports = { createYouTubeTokenManager, YOUTUBE_FORCE_SSL_SCOPE, youtubeError, safeYouTubeReason, mapYouTubeError };
