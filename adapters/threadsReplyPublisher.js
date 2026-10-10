"use strict";

const fetch = require("node-fetch");

function sanitizeMetaError(error) {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const redact = value => String(value ?? "")
    .replace(/((?:access_token|app_secret|client_secret|appsecret_proof)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .slice(0, 500);
  const fields = ["message", "type", "code", "error_subcode", "error_user_title", "error_user_msg", "fbtrace_id"];
  return Object.fromEntries(fields.filter(key => error[key] != null).map(key => [
    key, typeof error[key] === "string" ? redact(error[key]) : error[key],
  ]));
}

function createSafeReplyPublisher({
  getAccessToken,
  userId,
  fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  logger = console,
  baseUrl = "https://graph.threads.net",
  apiVersion = "v1.0",
  initialDelayMs = 5000,
  retryDelayMs = 7000,
  requestTimeoutMs = 6500,
  maxAttempts = 2,
} = {}) {
  if (typeof getAccessToken !== "function") throw new Error("getAccessToken required");
  const boundedAttempts = Math.max(1, Math.min(2, Number(maxAttempts) || 2));

  async function getContainerStatus(creationId) {
    const token = getAccessToken();
    if (!token) return { status: "UNKNOWN", reason: "TOKEN_MISSING" };
    try {
      const url = baseUrl + "/" + apiVersion + "/" + encodeURIComponent(creationId) + "?fields=status,error_message";
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        timeout: requestTimeoutMs,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body.status !== "string") {
        return { status: "UNKNOWN", reason: "HTTP_" + res.status };
      }
      const status = body.status.toUpperCase();
      if (!["FINISHED", "IN_PROGRESS", "PUBLISHED", "ERROR", "EXPIRED"].includes(status)) {
        return { status: "UNKNOWN", reason: "UNRECOGNIZED_STATUS" };
      }
      return { status, errorMessage: String(body.error_message || "").slice(0, 160) };
    } catch (_) {
      return { status: "UNKNOWN", reason: "STATUS_LOOKUP_FAILED" };
    }
  }

  function ambiguous(reason, details = {}) {
    return { status: "ambiguous", reason, ...details };
  }
  function failed(reason, details = {}) {
    return { status: "failed", reason, ...details };
  }

  async function publishReply(creationId) {
    if (!creationId || !userId || !getAccessToken()) return failed("MISSING_CONFIG");
    // Preserve the existing initial delay, without making a new container.
    await sleep(initialDelayMs);
    for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
      const token = getAccessToken();
      if (!token) return failed("TOKEN_MISSING");
      const url = baseUrl + "/" + apiVersion + "/" + encodeURIComponent(userId) +
        "/threads_publish?creation_id=" + encodeURIComponent(creationId);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          timeout: requestTimeoutMs,
        });
      } catch (_) {
        // This mutation may have happened. Never retry after a network error.
        logger.error("Threads publish outcome unknown", JSON.stringify({ creationId: String(creationId), reason: "NETWORK_OUTCOME_UNKNOWN" }));
        return ambiguous("NETWORK_OUTCOME_UNKNOWN");
      }
      const body = await response.json().catch(() => null);
      if (response.ok && body?.id) {
        logger.log("Threads reply posted", JSON.stringify({ id: String(body.id), creationId: String(creationId), attempt }));
        return { status: "published", id: String(body.id) };
      }
      if (response.ok || response.status === 429 || response.status >= 500 || body === null) {
        logger.error("Threads publish outcome unknown", JSON.stringify({ creationId: String(creationId), status: response.status, attempt }));
        return ambiguous("PUBLISH_OUTCOME_UNKNOWN", { httpStatus: response.status });
      }

      const metaError = sanitizeMetaError(body?.error);
      logger.error("Threads publish error", JSON.stringify({
        creationId: String(creationId), httpStatus: response.status, attempt, error: metaError,
      }));
      const code = Number(body?.error?.code);
      const subcode = Number(body?.error?.error_subcode) || null;
      if (response.status !== 400 || code !== 24) {
        return failed("META_REJECTED", { httpStatus: response.status, code: Number.isFinite(code) ? code : null, subcode });
      }

      // Code 24 can be a propagation race. Retry only the SAME container and
      // only when a read-only status check confirms it is not yet published.
      const current = await getContainerStatus(creationId);
      logger.log("Threads container status after code 24", JSON.stringify({
        creationId: String(creationId), status: current.status, reason: current.reason || null,
      }));
      if (current.status === "PUBLISHED") return ambiguous("ALREADY_PUBLISHED_ID_UNKNOWN", { code, subcode });
      if (current.status === "ERROR" || current.status === "EXPIRED") {
        return failed("CONTAINER_TERMINAL", { code, subcode, containerStatus: current.status });
      }
      if (current.status === "UNKNOWN") return ambiguous("CONTAINER_STATUS_UNVERIFIED", { code, subcode });
      if (attempt === boundedAttempts) return ambiguous("CODE_24_RETRY_EXHAUSTED", { code, subcode });
      await sleep(retryDelayMs);
      if (current.status === "IN_PROGRESS") {
        const latest = await getContainerStatus(creationId);
        if (latest.status === "ERROR" || latest.status === "EXPIRED") {
          return failed("CONTAINER_TERMINAL", { code, subcode, containerStatus: latest.status });
        }
        if (latest.status !== "FINISHED") {
          return ambiguous("CONTAINER_NOT_READY", { code, subcode, containerStatus: latest.status });
        }
      }
    }
    return ambiguous("RETRY_BUDGET_EXHAUSTED");
  }

  return { publishReply, getContainerStatus };
}

module.exports = { createSafeReplyPublisher, sanitizeMetaError };
