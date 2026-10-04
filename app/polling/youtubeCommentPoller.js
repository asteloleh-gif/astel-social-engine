const { createYouTubePollingStore } = require("./youtubePollingStore");

const TRANSIENT_REASONS = new Set([
  "BOT_DISABLED", "DURABLE_STORE_UNAVAILABLE", "COMMUNITY_RUNTIME_MISSING",
  "SAFETY_STORE_UNAVAILABLE", "REDIS_UNAVAILABLE", "BRANCH_LEASE_BUSY",
  "CONVERSATION_BUSY", "GENERATOR_FAILED", "QUOTA_EXCEEDED", "YOUTUBE_QUOTA_EXCEEDED",
  "AUTH_CHANNEL_UNVERIFIED", "YOUTUBE_CONTEXT_UNVERIFIED", "MODULE_OFF",
  "HUMAN_LOCK_STORE_UNAVAILABLE", "GRAPH_UNAVAILABLE", "BRANCH_LEASE_ERROR", "BRANCH_BUSY",
  "BRANCH_LEASE_LOST", "AI_EMPTY_OR_FAILED", "COMMENT_PREPARATION_ERROR",
  "DURABLE_OR_DRAFT_PREPARATION_FAILED", "COOLDOWN_ACTIVE", "GLOBAL_LIMIT_REACHED",
]);
const TERMINAL_STATUSES = new Set(["ok", "dry-run", "draft", "drafted", "ignored", "skipped", "human-review", "human_review"]);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}
function identifier(value) { return typeof value === "string" && value.trim() === value && value.length > 0; }
function fail(reason) { const error = new Error(reason); error.pollingReason = reason; throw error; }
function commentTimestamp(comment) { return Date.parse(comment?.snippet?.publishedAt || ""); }
function validateComment(comment, parentId = null) {
  const snippet = comment?.snippet;
  if (!identifier(comment?.id) || !snippet || typeof snippet !== "object"
    || !identifier(snippet.authorChannelId?.value) || !Number.isFinite(commentTimestamp(comment))
    || !(typeof snippet.textOriginal === "string" || typeof snippet.textDisplay === "string")
    || (parentId ? snippet.parentId !== parentId : Boolean(snippet.parentId))) fail("MALFORMED_COMMENT_RESPONSE");
}
function pageData(result, readReason) {
  if (result?.status !== "ok") fail(/^[A-Z][A-Z0-9_]{0,80}$/.test(result?.reason || "") ? result.reason : readReason);
  if (!Array.isArray(result.items)
    || (result.nextPageToken != null && typeof result.nextPageToken !== "string")) fail("MALFORMED_PAGE_RESPONSE");
  return { items: result.items, nextPageToken: result.nextPageToken || null };
}

function createYouTubeCommentPoller({
  provider,
  handler,
  redisUrl,
  enabled = false,
  intervalMs = 60000,
  maxResults = 100,
  fullScanEvery = 10,
  maxPages = 10000,
  store,
  logger = console,
  clock = () => Date.now(),
} = {}) {
  if (!provider || provider.platform !== "youtube") throw new Error("YouTube comment poller requires a YouTube provider");
  if (typeof handler !== "function") throw new Error("YouTube comment poller requires a handler");
  const accountKey = provider.accountKey;
  const channelId = String(provider.account?.channelId || provider.account?.userId || provider.channelId || "");
  // This rollout supports drafts only. A future live poller must use a distinct
  // mode namespace and the same underlying runtime's live-approval controls.
  const mode = "DRAFT_ONLY";
  const storeKey = JSON.stringify([accountKey, channelId, mode]);
  const pollStore = store || createYouTubePollingStore({ redisUrl });
  const pollEveryMs = clamp(intervalMs, 15000, 3600000, 60000);
  const pageSize = clamp(maxResults, 1, 100, 100);
  const fullScanCycles = clamp(fullScanEvery, 1, 10000, 10);
  const pageLimit = clamp(maxPages, 1, 100000, 10000);
  let timer = null;
  let running = false;
  let initialized = false;
  let primed = false;
  let cycleNumber = 0;
  let lastCycleAt = null;
  let lastError = null;
  let lastStats = null;
  let identityProbe = null;
  let startPromise = null;

  function health() {
    return {
      platform: "youtube", accountKey, channelId, enabled: Boolean(enabled), mode,
      liveTransportEnabled: false, running: Boolean(timer), cycleRunning: running,
      initialized, primed, intervalMs: pollEveryMs, maxResults: pageSize,
      fullScanEvery: fullScanCycles, lastCycleAt, lastError, lastStats,
      identityProbe, store: pollStore.health?.() || null,
    };
  }

  async function probeIdentity() {
    if (!identifier(channelId) || !identifier(accountKey) || typeof provider.getAccountIdentity !== "function") {
      identityProbe = { status: "failed", reason: "YOUTUBE_IDENTITY_CONFIG_MISSING" };
      fail(identityProbe.reason);
    }
    let result;
    try { result = await provider.getAccountIdentity(); } catch (_) {
      identityProbe = { status: "failed", reason: "IDENTITY_PROBE_FAILED" };
      fail(identityProbe.reason);
    }
    const observed = result?.identity?.id || result?.identity?.channelId;
    if (result?.status !== "ok") {
      identityProbe = { status: "failed", reason: /^[A-Z][A-Z0-9_]{0,80}$/.test(result?.reason || "") ? result.reason : "IDENTITY_PROBE_FAILED" };
      fail(identityProbe.reason);
    }
    if (observed !== channelId || (result.channelId != null && result.channelId !== channelId) || result.idMatch === false) {
      identityProbe = { status: "failed", reason: "AUTH_CHANNEL_MISMATCH", channelId, idMatch: false };
      fail(identityProbe.reason);
    }
    identityProbe = { status: "ok", channelId, idMatch: true };
  }

  async function ensureStore() {
    if (initialized) return;
    const result = await pollStore.init();
    if (result?.status !== "ok") fail("YOUTUBE_POLL_STORE_UNAVAILABLE");
    initialized = true;
  }

  function validBaseline(metadata) {
    return metadata?.version === 1 && metadata.channelId === channelId && metadata.mode === mode
      && Number.isFinite(metadata.baselineThrough) && metadata.baselineThrough >= 0
      && Number.isFinite(metadata.highWaterAt) && metadata.highWaterAt >= metadata.baselineThrough;
  }

  async function hydrate(thread, stats) {
    const snippet = thread?.snippet;
    const top = snippet?.topLevelComment;
    if (!identifier(thread?.id) || !snippet || !Number.isSafeInteger(snippet.totalReplyCount)
      || snippet.totalReplyCount < 0 || (snippet.channelId != null && snippet.channelId !== channelId)) fail("MALFORMED_THREAD_RESPONSE");
    validateComment(top);
    const topId = top.id;
    const videoId = snippet.videoId || top.snippet.videoId || null;
    if (videoId !== null && !identifier(videoId)) fail("MALFORMED_THREAD_RESPONSE");
    const embedded = thread.replies?.comments;
    if (embedded !== undefined && !Array.isArray(embedded)) fail("MALFORMED_REPLIES_RESPONSE");
    let replies = embedded || [];
    for (const reply of replies) validateComment(reply, topId);
    if (new Set(replies.map(reply => reply.id)).size !== replies.length) fail("MALFORMED_REPLIES_RESPONSE");
    if (replies.length < snippet.totalReplyCount) {
      if (typeof provider.listReplies !== "function") fail("REPLIES_READER_MISSING");
      replies = [];
      let pageToken;
      const tokens = new Set();
      const ids = new Set();
      do {
        if (tokens.size >= pageLimit) fail("PAGINATION_LIMIT_EXCEEDED");
        const tokenKey = pageToken || "";
        if (tokens.has(tokenKey)) fail("PAGINATION_CYCLE");
        tokens.add(tokenKey);
        stats.replyReads += 1;
        const page = pageData(await provider.listReplies(topId, { pageToken, maxResults: pageSize }), "REPLIES_READ_FAILED");
        for (const reply of page.items) {
          validateComment(reply, topId);
          if (ids.has(reply.id)) fail("MALFORMED_REPLIES_RESPONSE");
          ids.add(reply.id);
          replies.push(reply);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      if (replies.length < snippet.totalReplyCount) fail("INCOMPLETE_REPLY_CONTEXT");
    }
    const creatorReplied = replies.some(reply => reply.snippet.authorChannelId.value === channelId);
    return { threadId: thread.id, topId, videoId, creatorReplied, totalReplyCount: replies.length, comments: [top, ...replies] };
  }

  async function scan({ full, knownThreads }, stats) {
    const threads = [];
    const topIds = new Set();
    const commentIds = new Set();
    const tokens = new Set();
    let pageToken;
    do {
      if (tokens.size >= pageLimit) fail("PAGINATION_LIMIT_EXCEEDED");
      const tokenKey = pageToken || "";
      if (tokens.has(tokenKey)) fail("PAGINATION_CYCLE");
      tokens.add(tokenKey);
      stats.threadReads += 1;
      const page = pageData(await provider.listCommentThreads({ pageToken, maxResults: pageSize }), "THREADS_READ_FAILED");
      let pageKnown = page.items.length > 0;
      for (const native of page.items) {
        const thread = await hydrate(native, stats);
        if (topIds.has(thread.topId)) fail("MALFORMED_THREAD_RESPONSE");
        topIds.add(thread.topId);
        if (!knownThreads.has(thread.topId)) pageKnown = false;
        for (const comment of thread.comments) {
          if (commentIds.has(comment.id)) fail("MALFORMED_COMMENT_RESPONSE");
          commentIds.add(comment.id);
        }
        threads.push(thread);
      }
      if (!full && pageKnown) break;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return threads;
  }

  function finish(stats) {
    lastCycleAt = new Date(clock()).toISOString();
    lastError = stats.status === "failed" || stats.status === "partial" ? (stats.reason || "HANDLER_RETRY_PENDING") : null;
    lastStats = stats;
    // Only safe codes and aggregate counts; no OAuth errors, comment text, or tokens.
    logger.log?.("YouTube polling cycle", JSON.stringify({ accountKey, ...stats }));
    return stats;
  }

  async function runOnce() {
    if (!enabled) return { status: "skipped", reason: "YOUTUBE_POLLING_DISABLED" };
    if (provider.account?.enabled === false) return { status: "skipped", reason: "YOUTUBE_PROVIDER_DISABLED" };
    if (running) return { status: "skipped", reason: "CYCLE_ALREADY_RUNNING" };
    running = true;
    cycleNumber += 1;
    const scanStartedAt = Number(clock());
    const stats = { status: "ok", stage: "identity", threadReads: 0, replyReads: 0, discovered: 0, processed: 0, deferred: 0, failed: 0 };
    try {
      await probeIdentity();
      stats.stage = "store";
      await ensureStore();
      const state = await pollStore.getState(storeKey);
      if (!(state?.seen instanceof Set) || !(state?.knownThreads instanceof Set)) fail("YOUTUBE_POLL_STORE_INVALID");
      const baselineValid = validBaseline(state.metadata);
      primed = baselineValid && state.seenStatePresent === true;
      const needsPrime = !primed;
      const forceFullScan = needsPrime || cycleNumber % fullScanCycles === 0 || (state.seen.size > 0 && state.knownThreads.size === 0);
      stats.stage = needsPrime ? (state.metadata ? "re-prime" : "prime") : "scan";
      stats.forceFullScan = forceFullScan;
      const threads = await scan({ full: forceFullScan, knownThreads: state.knownThreads }, stats);
      stats.threads = threads.length;
      const allComments = threads.flatMap(thread => thread.comments);
      if (needsPrime) {
        const baselineThrough = allComments.reduce((latest, comment) => Math.max(latest, commentTimestamp(comment)),
          Math.max(scanStartedAt, baselineValid ? state.metadata.highWaterAt : 0));
        await pollStore.commitPrime(storeKey, {
          ids: allComments.map(comment => comment.id),
          threadIds: threads.map(thread => thread.topId),
          metadata: { version: 1, channelId, mode, primedAt: new Date(clock()).toISOString(), baselineThrough, highWaterAt: baselineThrough },
        });
        primed = true;
        stats.discovered = allComments.length;
        return finish(stats);
      }

      const discovered = [];
      const historical = [];
      for (const thread of threads) {
        for (const native of thread.comments) {
          if (state.seen.has(native.id)) continue;
          const timestamp = commentTimestamp(native);
          // This is the prime cutoff, not the advancing high-water. A failed old
          // candidate must remain retryable after newer candidates have succeeded.
          if (timestamp <= state.metadata.baselineThrough) { historical.push(native.id); continue; }
          const isTopLevel = native.id === thread.topId;
          const context = {
            threadId: thread.threadId, topLevelCommentId: thread.topId, videoId: thread.videoId,
            isTopLevel, channelId, creatorReplied: thread.creatorReplied, creatorAnswered: thread.creatorReplied,
            totalReplyCount: thread.totalReplyCount, contextComplete: true,
          };
          const normalized = provider.normalizePolledComment(native, context);
          if (!normalized || normalized.sourceId !== native.id || normalized.platform !== "youtube" || normalized.accountKey !== accountKey) fail("COMMENT_NORMALIZATION_FAILED");
          // The shared SocialEvent is frozen. Preserve that contract and never
          // silently lose verified hydration metadata through an assignment.
          const event = Object.freeze({ ...normalized, metadata: Object.freeze({
            ...normalized.metadata, ...context, pollingMode: mode,
            routingHint: isTopLevel ? "CLASSIFY" : "HUMAN_REVIEW",
          }) });
          discovered.push({ native, event, timestamp });
        }
      }
      discovered.sort((a, b) => a.timestamp - b.timestamp || a.native.id.localeCompare(b.native.id));
      stats.discovered = discovered.length;
      stats.historicalSkipped = historical.length;
      if (discovered.length) {
        stats.stage = "identity";
        await probeIdentity();
      }
      stats.stage = "process";
      let highWaterAt = state.metadata.highWaterAt;
      // Mark each confirmed terminal result immediately. Shared runtime source-id
      // idempotency protects the unavoidable crash window between handler and Redis.
      await pollStore.markSeen(storeKey, historical);
      for (const item of discovered) {
        let result;
        try {
          result = await handler({ platform: "youtube", provider, event: item.event, native: item.native, mode, liveTransportEnabled: false });
        } catch (_) {
          stats.failed += 1;
          continue;
        }
        if (result?.retryable === true || TRANSIENT_REASONS.has(result?.reason) || !TERMINAL_STATUSES.has(result?.status)) {
          stats.deferred += 1;
          continue;
        }
        await pollStore.markSeen(storeKey, [item.native.id]);
        highWaterAt = Math.max(highWaterAt, item.timestamp);
        stats.processed += 1;
      }
      await pollStore.markKnownThreads(storeKey, threads.map(thread => thread.topId));
      await pollStore.updateHighWater(storeKey, state.metadata, highWaterAt);
      if (stats.failed || stats.deferred) stats.status = "partial";
      return finish(stats);
    } catch (error) {
      stats.status = "failed";
      stats.reason = error?.pollingReason || "YOUTUBE_POLLING_FAILED";
      return finish(stats);
    } finally {
      running = false;
    }
  }

  async function init() {
    if (timer) return { status: "ok", reason: "ALREADY_STARTED" };
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const first = await runOnce();
      if (first.status === "skipped" || first.status === "failed") return first;
      timer = setInterval(() => { runOnce().catch(() => { lastError = "YOUTUBE_POLLING_FAILED"; }); }, pollEveryMs);
      timer.unref?.();
      return { status: "ok", reason: "STARTED", identityProbe, first };
    })();
    try { return await startPromise; } finally { startPromise = null; }
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await pollStore.close?.();
    initialized = false;
  }

  return { init, runOnce, stop, health };
}

module.exports = { createYouTubeCommentPoller };
