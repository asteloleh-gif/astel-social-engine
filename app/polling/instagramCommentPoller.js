const { createInstagramPollingStore } = require("./instagramPollingStore");

const TRANSIENT_REASONS = new Set([
  "DURABLE_STORE_UNAVAILABLE",
  "COMMUNITY_RUNTIME_MISSING",
  "SAFETY_STORE_UNAVAILABLE",
]);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function safeAuthDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  return {
    pagesVisible: Number.isFinite(Number(value.pagesVisible)) ? Number(value.pagesVisible) : 0,
    pagesWithInstagram: Number.isFinite(Number(value.pagesWithInstagram)) ? Number(value.pagesWithInstagram) : 0,
    identityLookupAttempts: Number.isFinite(Number(value.identityLookupAttempts)) ? Number(value.identityLookupAttempts) : 0,
    identityLookupSuccesses: Number.isFinite(Number(value.identityLookupSuccesses)) ? Number(value.identityLookupSuccesses) : 0,
    pageTokenFallbackConfigured: Boolean(value.pageTokenFallbackConfigured),
    pageTokenFallbackAttempted: Boolean(value.pageTokenFallbackAttempted),
    pageTokenFallbackHasInstagram: Boolean(value.pageTokenFallbackHasInstagram),
  };
}

function createInstagramCommentPoller({
  provider,
  handler,
  redisUrl,
  enabled = false,
  intervalMs = 60000,
  mediaLimit = 10,
  commentsLimit = 50,
  fullScanEvery = 10,
  store,
  logger = console,
} = {}) {
  if (!provider || provider.platform !== "instagram") {
    throw new Error("Instagram comment poller requires an Instagram provider");
  }
  if (typeof handler !== "function") {
    throw new Error("Instagram comment poller requires a handler");
  }

  const accountKey = provider.accountKey;
  const pollStore = store || createInstagramPollingStore({ redisUrl });
  const pollEveryMs = clamp(intervalMs, 15000, 3600000, 60000);
  const recentMediaLimit = clamp(mediaLimit, 1, 25, 10);
  const perMediaCommentsLimit = clamp(commentsLimit, 1, 50, 50);
  const fullScanCycles = clamp(fullScanEvery, 1, 60, 10);

  let timer = null;
  let running = false;
  let initialized = false;
  let primed = false;
  let cycleNumber = 0;
  let lastCycleAt = null;
  let lastError = null;
  let lastStats = null;
  let lastIdentityProbe = null;

  function health() {
    return {
      platform: "instagram",
      accountKey,
      enabled: Boolean(enabled),
      running: Boolean(timer),
      initialized,
      primed,
      intervalMs: pollEveryMs,
      mediaLimit: recentMediaLimit,
      commentsLimit: perMediaCommentsLimit,
      fullScanEvery: fullScanCycles,
      lastCycleAt,
      lastError,
      lastStats,
      identityProbe: lastIdentityProbe,
      store: pollStore.health?.() || null,
    };
  }

  async function probeIdentity() {
    if (typeof provider.getAccountIdentity !== "function") {
      lastIdentityProbe = { status: "skipped", reason: "IDENTITY_PROBE_UNSUPPORTED" };
      return lastIdentityProbe;
    }

    let result;
    try {
      result = await provider.getAccountIdentity();
    } catch (error) {
      result = { status: "failed", reason: "IDENTITY_PROBE_EXCEPTION" };
    }

    const diagnostics = safeAuthDiagnostics(result?.diagnostics);
    if (result?.status !== "ok") {
      lastIdentityProbe = {
        status: "failed",
        reason: result?.reason || "IDENTITY_PROBE_FAILED",
        code: result?.code || null,
        ...(diagnostics ? { diagnostics } : {}),
      };
      logger.log("Instagram identity probe", JSON.stringify({ accountKey, ...lastIdentityProbe }));
      return lastIdentityProbe;
    }

    const identity = result.identity || {};
    const configuredUserId = String(provider.account?.userId || "").trim();
    const configuredUsername = String(provider.account?.username || "").trim().toLowerCase();
    const candidateIds = [identity.id, identity.userId].filter(Boolean).map(String);
    const observedUsername = String(identity.username || "").trim().toLowerCase();

    lastIdentityProbe = {
      status: "ok",
      idMatch: Boolean(configuredUserId && candidateIds.includes(configuredUserId)),
      usernameMatch: Boolean(configuredUsername && observedUsername && configuredUsername === observedUsername),
      accountType: identity.accountType || null,
      mediaCount: Number.isFinite(identity.mediaCount) ? identity.mediaCount : null,
      ...(result?.resolution ? { resolution: String(result.resolution) } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
    logger.log("Instagram identity probe", JSON.stringify({ accountKey, ...lastIdentityProbe }));
    return lastIdentityProbe;
  }

  async function readMediaComments(media, { force = false } = {}) {
    if (!force && (Number(media?.comments_count) || 0) <= 0) return { status: "ok", items: [] };
    return provider.listComments(media.id, { limit: perMediaCommentsLimit });
  }

  async function prime(mediaItems) {
    const allIds = [];
    const counts = {};
    let readFailures = 0;

    for (const media of mediaItems) {
      if (!media?.id) continue;
      counts[String(media.id)] = Number(media.comments_count) || 0;
      const result = await readMediaComments(media, { force: true });
      if (result.status !== "ok") {
        readFailures += 1;
        continue;
      }
      for (const comment of result.items || []) {
        if (comment?.id) allIds.push(String(comment.id));
      }
    }

    if (readFailures) {
      return { status: "failed", reason: "PRIME_READ_FAILED", readFailures };
    }

    await pollStore.markSeen(accountKey, allIds);
    await pollStore.setMediaCounts(accountKey, counts);
    await pollStore.markPrimed(accountKey);
    primed = true;
    return { status: "ok", discovered: allIds.length };
  }

  function recordPrimeResult(stage, mediaItems, result) {
    lastCycleAt = new Date().toISOString();
    lastError = result.status === "ok" ? null : result.reason;
    lastStats = {
      status: result.status,
      stage,
      media: mediaItems.length,
      discovered: result.discovered || 0,
      reason: result.reason || null,
    };
    logger.log("Instagram polling primed", JSON.stringify({ accountKey, ...lastStats }));
    return lastStats;
  }

  async function runOnce() {
    if (!enabled) return { status: "skipped", reason: "INSTAGRAM_POLLING_DISABLED" };
    if (running) return { status: "skipped", reason: "CYCLE_ALREADY_RUNNING" };
    running = true;
    cycleNumber += 1;
    try {
      const mediaResult = await provider.listRecentMedia({ limit: recentMediaLimit });
      if (mediaResult.status !== "ok") {
        lastError = `${mediaResult.reason || "MEDIA_READ_FAILED"}${mediaResult.code ? `:${mediaResult.code}` : ""}`;
        lastStats = { status: "failed", stage: "media", reason: mediaResult.reason || null, code: mediaResult.code || null };
        return lastStats;
      }

      const mediaItems = Array.isArray(mediaResult.items) ? mediaResult.items.filter(item => item?.id) : [];
      primed = await pollStore.isPrimed(accountKey);
      if (!primed) {
        return recordPrimeResult("prime", mediaItems, await prime(mediaItems));
      }

      const previousCounts = await pollStore.getMediaCounts(accountKey);

      // Development-mode Instagram can return a valid 200 with no live media.
      // When Live mode later exposes media, establish a fresh baseline first so
      // old comments are never mistaken for new comments and mass-processed.
      if (mediaItems.length > 0 && Object.keys(previousCounts).length === 0) {
        return recordPrimeResult("re-prime", mediaItems, await prime(mediaItems));
      }

      const seen = await pollStore.getSeen(accountKey);
      const nextCounts = {};
      const discovered = [];
      let reads = 0;
      let readFailures = 0;
      const forceFullScan = cycleNumber % fullScanCycles === 0;

      for (const media of mediaItems) {
        const mediaId = String(media.id);
        const currentCount = Number(media.comments_count) || 0;
        nextCounts[mediaId] = currentCount;
        const previousCount = Object.prototype.hasOwnProperty.call(previousCounts, mediaId)
          ? Number(previousCounts[mediaId]) || 0
          : null;

        if (!forceFullScan && previousCount !== null && currentCount === previousCount) continue;
        if (!forceFullScan && currentCount <= 0) continue;

        const commentsResult = await readMediaComments(media, { force: forceFullScan });
        reads += 1;
        if (commentsResult.status !== "ok") {
          readFailures += 1;
          continue;
        }

        for (const comment of commentsResult.items || []) {
          const commentId = String(comment?.id || "").trim();
          if (!commentId || seen.has(commentId)) continue;
          const event = provider.normalizePolledComment(comment, mediaId);
          if (!event) continue;
          discovered.push({ commentId, event, native: comment });
        }
      }

      discovered.sort((a, b) => {
        const at = Date.parse(a.event?.timestamp || "") || 0;
        const bt = Date.parse(b.event?.timestamp || "") || 0;
        return at - bt;
      });

      let processed = 0;
      let deferred = 0;
      let failed = 0;
      const marked = [];

      for (const item of discovered) {
        try {
          const result = await handler({
            platform: "instagram",
            provider,
            event: item.event,
            native: item.native,
          });
          if (result?.status === "ignored" && TRANSIENT_REASONS.has(result?.reason)) {
            deferred += 1;
            continue;
          }
          marked.push(item.commentId);
          seen.add(item.commentId);
          processed += 1;
        } catch (error) {
          failed += 1;
          lastError = error?.message || String(error);
        }
      }

      await pollStore.markSeen(accountKey, marked);
      await pollStore.setMediaCounts(accountKey, nextCounts);
      lastCycleAt = new Date().toISOString();
      if (!failed && !readFailures) lastError = null;
      lastStats = {
        status: failed || readFailures ? "partial" : "ok",
        media: mediaItems.length,
        reads,
        readFailures,
        forceFullScan,
        discovered: discovered.length,
        processed,
        deferred,
        failed,
      };

      if (discovered.length || readFailures || failed || forceFullScan) {
        logger.log("Instagram polling cycle", JSON.stringify({ accountKey, ...lastStats }));
      }
      return lastStats;
    } finally {
      running = false;
    }
  }

  async function init() {
    initialized = true;
    if (!enabled) return { status: "skipped", reason: "INSTAGRAM_POLLING_DISABLED" };
    if (!provider.account?.enabled) return { status: "skipped", reason: "INSTAGRAM_PROVIDER_DISABLED" };
    if (!provider.account?.accessToken || !provider.account?.userId) {
      return { status: "failed", reason: "INSTAGRAM_CONFIG_MISSING" };
    }
    const storeStart = await pollStore.init();
    if (storeStart.status !== "ok") {
      lastError = storeStart.reason;
      return storeStart;
    }
    await probeIdentity();
    const first = await runOnce();
    timer = setInterval(() => {
      runOnce().catch(error => {
        lastError = error?.message || String(error);
        logger.error("Instagram polling error", JSON.stringify({ accountKey, error: lastError }));
      });
    }, pollEveryMs);
    timer.unref?.();
    return { status: "ok", reason: "STARTED", identityProbe: lastIdentityProbe, first };
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await pollStore.close?.();
  }

  return { init, runOnce, stop, health };
}

module.exports = { createInstagramCommentPoller };
