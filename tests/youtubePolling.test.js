const test = require("node:test");
const assert = require("node:assert/strict");
const { createYouTubeCommentPoller } = require("../app/polling/youtubeCommentPoller");
const { createYouTubePollingStore } = require("../app/polling/youtubePollingStore");

const CHANNEL = "UC_AsApGTA6";
const ACCOUNT = "asap:youtube";
const NOW = Date.parse("2026-10-04T12:00:00Z");
const logger = { log() {}, error() {} };
const iso = offset => new Date(NOW + offset).toISOString();
const key = JSON.stringify([ACCOUNT, CHANNEL, "DRAFT_ONLY"]);
function comment(id, offset = -10000, { parentId, author = "UC_viewer", text = "What do you think?" } = {}) {
  return { id, snippet: { publishedAt: iso(offset), authorChannelId: { value: author },
    authorDisplayName: "Viewer", textOriginal: text, videoId: "video-1", ...(parentId ? { parentId } : {}) } };
}
function thread(id, { replies = [], count = replies.length, offset = -10000 } = {}) {
  return { id: `thread-${id}`, snippet: { channelId: CHANNEL, videoId: "video-1",
    totalReplyCount: count, topLevelComment: comment(id, offset) }, replies: { comments: replies } };
}
function page(items, nextPageToken = null) { return { status: "ok", items, nextPageToken }; }

// All tests use an in-memory Redis protocol double; no Redis/API/OAuth/network.
function redisFixture() {
  const values = new Map();
  const sets = new Map();
  const writes = [];
  const expires = [];
  let failMetadataCommit = false;
  const clientFactory = () => ({
    on() {}, async connect() {}, async quit() {},
    async get(k) { return values.get(k) ?? null; },
    async set(k, value, options) {
      writes.push({ k, value, options });
      if (failMetadataCommit && value.includes('"version":1')) throw new Error("redis://secret@example.test");
      values.set(k, value);
    },
    async sMembers(k) { return [...(sets.get(k) || [])]; },
    async sAdd(k, ids) { const set = sets.get(k) || new Set(); ids.forEach(id => set.add(id)); sets.set(k, set); },
    async expire(k, seconds) { expires.push({ k, seconds }); },
  });
  return {
    values, sets, writes, expires, clientFactory,
    store(options = {}) { return createYouTubePollingStore({ redisUrl: "redis://mock", clientFactory, ...options }); },
    loseSeen() { for (const k of sets.keys()) if (k.endsWith(":seen")) sets.delete(k); },
    loseKnown() { for (const k of sets.keys()) if (k.endsWith(":posts")) sets.delete(k); },
    failCommit(value) { failMetadataCommit = value; },
  };
}
function fixture(options = {}) {
  const redis = options.redis || redisFixture();
  const store = options.store || redis.store();
  let pages = [page([thread("old")])];
  let replies = {};
  let identity = { status: "ok", identity: { id: CHANNEL }, channelId: CHANNEL, idMatch: true };
  const reads = [];
  const handled = [];
  let probes = 0;
  const provider = {
    platform: "youtube", accountKey: ACCOUNT, account: { enabled: true, userId: CHANNEL },
    async getAccountIdentity() { probes += 1; return typeof identity === "function" ? identity(probes) : identity; },
    async listCommentThreads({ pageToken, maxResults }) {
      reads.push({ type: "threads", pageToken, maxResults });
      const index = pageToken ? Number(pageToken) : 0;
      const result = pages[index];
      if (result instanceof Error) throw result;
      return result;
    },
    async listReplies(topId, { pageToken, maxResults }) {
      reads.push({ type: "replies", topId, pageToken, maxResults });
      const result = replies[topId]?.[pageToken ? Number(pageToken) : 0];
      if (result instanceof Error) throw result;
      return result;
    },
    normalizePolledComment(native, context) {
      return { platform: "youtube", accountKey: ACCOUNT, sourceId: native.id, text: native.snippet.textOriginal,
        author: { id: native.snippet.authorChannelId.value }, timestamp: native.snippet.publishedAt,
        parentId: native.snippet.parentId || context.videoId, rootId: context.videoId, metadata: { ...context } };
    },
    async reply() { assert.fail("No live writes are permitted"); },
    async deleteComment() { assert.fail("No moderation writes are permitted"); },
  };
  const poller = createYouTubeCommentPoller({
    provider, store, enabled: true, clock: () => NOW, logger,
    handler: async payload => { handled.push(payload); return options.handler ? options.handler(payload) : { status: "dry-run" }; },
    ...(options.pollerOptions || {}),
  });
  return { redis, store, provider, poller, reads, handled,
    setPages(value) { pages = value; }, setReplies(value) { replies = value; }, setIdentity(value) { identity = value; },
    get probes() { return probes; }, state() { return store.getState(key); } };
}

test("YouTube polling defaults off and performs no reads or writes", async () => {
  const f = fixture({ pollerOptions: { enabled: false } });
  assert.deepEqual(await f.poller.runOnce(), { status: "skipped", reason: "YOUTUBE_POLLING_DISABLED" });
  assert.equal(f.probes, 0);
  assert.equal(f.redis.writes.length, 0);
  assert.equal(f.poller.health().mode, "DRAFT_ONLY");
  assert.equal(f.poller.health().liveTransportEnabled, false);
});

test("YouTube exact channel identity fails closed before scanning or dispatching", async t => {
  for (const identity of [
    { status: "ok", identity: { id: CHANNEL.toLowerCase() }, idMatch: true },
    { status: "ok", identity: { id: CHANNEL }, channelId: "UC_wrong", idMatch: true },
    { status: "ok", identity: { id: CHANNEL }, idMatch: false },
    { status: "failed", reason: "AUTH_CHANNEL_MISMATCH" },
    { status: "ok" },
  ]) await t.test(JSON.stringify(identity), async () => {
    const f = fixture(); f.setIdentity(identity);
    assert.equal((await f.poller.runOnce()).reason, "AUTH_CHANNEL_MISMATCH");
    assert.equal(f.reads.length, 0);
    assert.equal(f.handled.length, 0);
    assert.equal(f.redis.writes.length, 0);
  });
});

test("YouTube prime fully paginates top-level and hydrated replies without processing history", async () => {
  const f = fixture();
  const r1 = comment("old-reply-1", -9000, { parentId: "old" });
  const r2 = comment("old-reply-2", -8000, { parentId: "old", author: CHANNEL });
  f.setPages([page([thread("old", { count: 2, replies: [r1] })], "1"), page([thread("older", { offset: -20000 })])]);
  f.setReplies({ old: [page([r1], "1"), page([r2])] });
  const result = await f.poller.runOnce();
  assert.equal(result.stage, "prime");
  assert.equal(result.discovered, 4);
  assert.equal(result.threadReads, 2);
  assert.equal(result.replyReads, 2);
  assert.equal(f.handled.length, 0);
  const state = await f.state();
  assert.deepEqual([...state.seen].sort(), ["old", "old-reply-1", "old-reply-2", "older"]);
  assert.equal(state.metadata.baselineThrough, NOW);
  assert.equal(state.seenStatePresent, true);
  assert.equal(state.metadata.channelId, CHANNEL);
});

test("YouTube hydration follows all reply pages even when stated count was already reached", async () => {
  const f = fixture();
  f.setPages([page([thread("old", { count: 1 })])]);
  f.setReplies({ old: [page([comment("r1", -10, { parentId: "old" })], "1"), page([comment("r2", -5, { parentId: "old" })])] });
  const result = await f.poller.runOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.replyReads, 2);
  assert.equal((await f.state()).seen.has("r2"), true);
});

test("YouTube prime failure on later page never commits or dispatches partial history", async () => {
  const f = fixture();
  f.setPages([page([thread("old")], "1"), { status: "failed", reason: "COMMENTS_DISABLED" }]);
  const result = await f.poller.runOnce();
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "COMMENTS_DISABLED");
  assert.equal((await f.state()).metadata, null);
  assert.equal((await f.state()).seen.size, 0);
  assert.equal(f.handled.length, 0);
  f.setPages([page([thread("old")], "1"), page([thread("older")])]);
  assert.equal((await f.poller.runOnce()).stage, "prime");
  assert.equal(f.handled.length, 0);
});

test("YouTube prime rejects malformed or incomplete replies and never promotes partial context", async t => {
  const cases = [
    { name: "malformed page", pages: [{ status: "ok", items: null }], reason: "MALFORMED_PAGE_RESPONSE" },
    { name: "bad page token", pages: [{ status: "ok", items: [], nextPageToken: 4 }], reason: "MALFORMED_PAGE_RESPONSE" },
    { name: "missing author", mutate(t) { delete t.snippet.topLevelComment.snippet.authorChannelId; }, reason: "MALFORMED_COMMENT_RESPONSE" },
    { name: "invalid timestamp", mutate(t) { t.snippet.topLevelComment.snippet.publishedAt = "invalid"; }, reason: "MALFORMED_COMMENT_RESPONSE" },
    { name: "invalid count", mutate(t) { t.snippet.totalReplyCount = "1"; }, reason: "MALFORMED_THREAD_RESPONSE" },
    { name: "different channel", mutate(t) { t.snippet.channelId = "UC_other"; }, reason: "MALFORMED_THREAD_RESPONSE" },
    { name: "wrong parent", count: 1, replies: [page([comment("r1", -10, { parentId: "wrong" })])], reason: "MALFORMED_COMMENT_RESPONSE" },
    { name: "too few replies", count: 2, replies: [page([comment("r1", -10, { parentId: "old" })])], reason: "INCOMPLETE_REPLY_CONTEXT" },
    { name: "failed replies", count: 1, replies: [{ status: "failed", reason: "INSUFFICIENT_PERMISSIONS" }], reason: "INSUFFICIENT_PERMISSIONS" },
    { name: "duplicate replies", count: 2, replies: [page([comment("r1", -10, { parentId: "old" }), comment("r1", -10, { parentId: "old" })])], reason: "MALFORMED_REPLIES_RESPONSE" },
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const f = fixture(); const top = thread("old", { count: c.count || 0 }); c.mutate?.(top);
    f.setPages(c.pages || [page([top])]); if (c.replies) f.setReplies({ old: c.replies });
    assert.equal((await f.poller.runOnce()).reason, c.reason);
    assert.equal((await f.state()).metadata, null);
    assert.equal(f.handled.length, 0);
  });
});

test("YouTube newest-page scans stop at a known top-level page and process discovered oldest first", async () => {
  const f = fixture();
  f.setPages([page([thread("old")], "1"), page([thread("older")])]);
  await f.poller.runOnce(); f.reads.length = 0;
  f.setPages([page([thread("newer", { offset: 2000 }), thread("new", { offset: 1000 })], "1"),
    page([thread("old")], "2"), page([thread("older")])]);
  const result = await f.poller.runOnce();
  assert.equal(result.forceFullScan, false);
  assert.equal(result.threadReads, 2);
  assert.deepEqual(f.handled.map(p => p.event.sourceId), ["new", "newer"]);
  assert.equal(f.handled[0].event.metadata.isTopLevel, true);
  assert.equal(f.handled[0].event.metadata.contextComplete, true);
  assert.equal(f.handled[0].event.metadata.channelId, CHANNEL);
  assert.equal(f.handled[0].mode, "DRAFT_ONLY");
  assert.equal(f.handled[0].liveTransportEnabled, false);
  assert.equal((await f.poller.runOnce()).discovered, 0);
});

test("YouTube reconciliation catches replies on older threads without inventing nesting", async () => {
  const f = fixture({ pollerOptions: { fullScanEvery: 3 } });
  const pages = [page([thread("old")], "1"), page([thread("older")])];
  f.setPages(pages); await f.poller.runOnce();
  pages[1] = page([thread("older", { replies: [comment("new-sibling", 1000, { parentId: "older" })] })]);
  assert.equal((await f.poller.runOnce()).discovered, 0);
  const result = await f.poller.runOnce();
  assert.equal(result.forceFullScan, true);
  assert.deepEqual(f.handled.map(p => p.event.sourceId), ["new-sibling"]);
  const event = f.handled[0].event;
  assert.equal(event.parentId, "older");
  assert.equal(event.metadata.topLevelCommentId, "older");
  assert.equal(event.metadata.isTopLevel, false);
  assert.equal(event.metadata.routingHint, "HUMAN_REVIEW");
});

test("YouTube creator-answered state comes from fully hydrated replies before top-level dispatch", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.setPages([page([thread("new", { offset: 1000, count: 2 })])]);
  f.setReplies({ new: [page([comment("viewer", 2000, { parentId: "new" })], "1"),
    page([comment("creator", 3000, { parentId: "new", author: CHANNEL })])] });
  assert.equal((await f.poller.runOnce()).processed, 3);
  assert.deepEqual(f.handled.map(p => p.event.sourceId), ["new", "viewer", "creator"]);
  for (const payload of f.handled) {
    assert.equal(payload.event.metadata.creatorReplied, true);
    assert.equal(payload.event.metadata.creatorAnswered, true);
    assert.equal(payload.event.metadata.contextComplete, true);
  }
});

test("YouTube read failure anywhere in a scan prevents all processing and all seen changes", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.setPages([page([thread("safe-new", { offset: 1000 }), thread("unsafe-new", { offset: 2000, count: 1 })])]);
  f.setReplies({ "unsafe-new": [{ status: "failed", reason: "QUOTA_EXCEEDED" }] });
  const result = await f.poller.runOnce();
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "QUOTA_EXCEEDED");
  assert.equal(f.handled.length, 0);
  assert.equal((await f.state()).seen.has("safe-new"), false);
});

test("YouTube rechecks exact identity after hydration and before dispatch", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.setPages([page([thread("new", { offset: 1000 })])]);
  f.setIdentity(n => ({ status: "ok", identity: { id: n < 3 ? CHANNEL : "UC_other" } }));
  assert.equal((await f.poller.runOnce()).reason, "AUTH_CHANNEL_MISMATCH");
  assert.equal(f.handled.length, 0);
  assert.equal((await f.state()).seen.has("new"), false);
});

test("YouTube shared Redis restart preserves source-id dedupe", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.setPages([page([thread("new", { offset: 1000 })])]); await f.poller.runOnce();
  const restarted = fixture({ redis: f.redis });
  restarted.setPages([page([thread("new", { offset: 1000 }), thread("old")])]);
  const result = await restarted.poller.runOnce();
  assert.equal(result.stage, "process");
  assert.equal(result.discovered, 0);
  assert.equal(restarted.handled.length, 0);
});

test("YouTube lost TTL seen state forces complete re-prime, never a historical reply blast", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.setPages([page([thread("new", { offset: 1000 })], "1"), page([thread("old")])]);
  await f.poller.runOnce();
  const before = f.handled.length;
  f.redis.loseSeen();
  f.setPages([page([thread("newest", { offset: 2000 }), thread("new", { offset: 1000 })], "1"), page([thread("old")])]);
  const result = await f.poller.runOnce();
  assert.equal(result.stage, "re-prime");
  assert.equal(result.threadReads, 2);
  assert.equal(f.handled.length, before);
  assert.equal((await f.state()).metadata.baselineThrough, NOW + 2000);
});

test("YouTube lost known-thread TTL forces full reconciliation without dropping seen state", async () => {
  const f = fixture(); await f.poller.runOnce(); f.redis.loseKnown();
  f.setPages([page([thread("old")], "1"), page([thread("new", { offset: 1000 })])]);
  const result = await f.poller.runOnce();
  assert.equal(result.forceFullScan, true);
  assert.deepEqual(f.handled.map(p => p.event.sourceId), ["new"]);
});

test("YouTube durable baseline prevents newly visible historical comments after an empty prime", async () => {
  const f = fixture(); f.setPages([page([])]); await f.poller.runOnce();
  f.setPages([page([thread("old"), thread("new", { offset: 1000 })])]);
  const result = await f.poller.runOnce();
  assert.equal(result.historicalSkipped, 1);
  assert.deepEqual(f.handled.map(p => p.event.sourceId), ["new"]);
  assert.equal((await f.state()).seen.has("old"), true);
});

test("YouTube malformed durable baseline triggers safe full re-prime", async () => {
  const f = fixture(); await f.poller.runOnce();
  for (const k of f.redis.values.keys()) f.redis.values.set(k, '{"version":1,"channelId":"different"}');
  f.setPages([page([thread("new", { offset: 1000 }), thread("old")])]);
  assert.equal((await f.poller.runOnce()).stage, "re-prime");
  assert.equal(f.handled.length, 0);
});

test("YouTube failed candidates stay unmarked across newer successes, restart and reconciliation", async () => {
  let retry = false;
  const f = fixture({ handler: p => p.event.sourceId === "retry" && !retry
    ? { status: "ignored", reason: "DURABLE_OR_DRAFT_PREPARATION_FAILED" } : { status: "dry-run" } });
  await f.poller.runOnce();
  const pages = [page([thread("success", { offset: 3000 })], "1"), page([thread("retry", { offset: 1000 })], "2"), page([thread("old")])];
  f.setPages(pages);
  const result = await f.poller.runOnce();
  assert.equal(result.deferred, 1);
  assert.equal((await f.state()).seen.has("retry"), false);
  assert.equal((await f.state()).metadata.highWaterAt, NOW + 3000);
  retry = true;
  const restarted = fixture({ redis: f.redis, pollerOptions: { fullScanEvery: 1 } });
  restarted.setPages(pages);
  assert.equal((await restarted.poller.runOnce()).processed, 1);
  assert.deepEqual(restarted.handled.map(p => p.event.sourceId), ["retry"]);
});

test("YouTube handler exceptions and explicitly retryable results are not marked seen", async () => {
  let attempt = 0;
  const f = fixture({ handler() { attempt += 1; if (attempt === 1) throw new Error("secret");
    if (attempt === 2) return { status: "ignored", reason: "TEMPORARY", retryable: true }; return { status: "dry-run" }; } });
  await f.poller.runOnce(); f.setPages([page([thread("new", { offset: 1000 })])]);
  assert.equal((await f.poller.runOnce()).failed, 1);
  assert.equal((await f.state()).seen.has("new"), false);
  assert.equal((await f.poller.runOnce()).deferred, 1);
  assert.equal((await f.state()).seen.has("new"), false);
  assert.equal((await f.poller.runOnce()).processed, 1);
  assert.equal((await f.state()).seen.has("new"), true);
  assert.doesNotMatch(JSON.stringify(f.poller.health()), /secret/);
});

test("YouTube invalid normalization fails whole scan before any dispatch", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.setPages([page([thread("new", { offset: 1000 }), thread("bad", { offset: 2000 })])]);
  const normalize = f.provider.normalizePolledComment;
  f.provider.normalizePolledComment = (native, context) => native.id === "bad" ? null : normalize(native, context);
  assert.equal((await f.poller.runOnce()).reason, "COMMENT_NORMALIZATION_FAILED");
  assert.equal(f.handled.length, 0);
  assert.equal((await f.state()).seen.has("new"), false);
});

test("YouTube repeated page cursors and configured pagination limits fail closed", async t => {
  await t.test("cursor loop", async () => {
    const f = fixture(); f.setPages([page([], "1"), page([], "1")]);
    assert.equal((await f.poller.runOnce()).reason, "PAGINATION_CYCLE");
    assert.equal((await f.state()).metadata, null);
  });
  await t.test("page budget", async () => {
    const f = fixture({ pollerOptions: { maxPages: 1 } }); f.setPages([page([thread("old")], "1")]);
    assert.equal((await f.poller.runOnce()).reason, "PAGINATION_LIMIT_EXCEEDED");
    assert.equal((await f.state()).metadata, null);
  });
});

test("YouTube polling store preserves exact case/mode isolation and durable metadata with TTL sets", async () => {
  const redis = redisFixture(); const store = redis.store({ ttlSeconds: 60 }); await store.init();
  const metadata = { version: 1, channelId: CHANNEL, mode: "DRAFT_ONLY", baselineThrough: NOW, highWaterAt: NOW };
  await store.commitPrime("UC_Case:DRAFT_ONLY", { ids: ["one"], threadIds: ["top"], metadata });
  await store.commitPrime("UC_case:DRAFT_ONLY", { ids: ["two"], threadIds: [], metadata });
  await store.commitPrime("UC_Case:LIVE_APPROVED", { ids: ["three"], threadIds: [], metadata });
  assert.deepEqual([...(await store.getState("UC_Case:DRAFT_ONLY")).seen], ["one"]);
  assert.deepEqual([...(await store.getState("UC_case:DRAFT_ONLY")).seen], ["two"]);
  assert.deepEqual([...(await store.getState("UC_Case:LIVE_APPROVED")).seen], ["three"]);
  assert.ok(redis.writes.every(write => write.options === undefined));
  assert.ok(redis.expires.length >= 4);
  assert.ok(redis.expires.every(({ seconds, k }) => seconds === 60 && !k.endsWith(":baseline")));
});

test("YouTube interrupted prime cannot leave a durable successful marker", async () => {
  const f = fixture(); await f.poller.runOnce(); f.redis.loseSeen(); f.redis.failCommit(true);
  f.setPages([page([thread("new", { offset: 1000 })])]);
  assert.equal((await f.poller.runOnce()).status, "failed");
  assert.equal((await f.state()).metadata.version, 0);
  f.redis.failCommit(false);
  assert.equal((await f.poller.runOnce()).stage, "re-prime");
  assert.equal(f.handled.length, 0);
  assert.doesNotMatch(JSON.stringify(f.poller.health()), /secret@example/);
});

test("YouTube polling failed startup creates no timer and health exposes only safe codes", async () => {
  const f = fixture(); f.provider.getAccountIdentity = async () => { throw new Error("Bearer access-secret"); };
  const result = await f.poller.init();
  assert.equal(result.status, "failed");
  assert.equal(f.poller.health().running, false);
  assert.equal(f.poller.health().lastError, "IDENTITY_PROBE_FAILED");
  assert.doesNotMatch(JSON.stringify(f.poller.health()), /access-secret/);
  await f.poller.stop();
});

test("YouTube poller composes actual frozen provider events with complete review metadata", async () => {
  const { createYouTubeProvider } = require("../app/providers/youtubeProvider");
  const realProvider = createYouTubeProvider({ account: { platform: "youtube", key: ACCOUNT, userId: CHANNEL, enabled: true },
    env: {}, tokenManager: {}, quotaStore: {}, fetchImpl: async () => { assert.fail("Normalizer does not need the API"); } });
  const f = fixture();
  f.provider.normalizePolledComment = realProvider.normalizePolledComment;
  await f.poller.runOnce();
  f.setPages([page([thread("old", { replies: [comment("new", 1000, { parentId: "old" })] })])]);
  const result = await f.poller.runOnce();
  assert.equal(result.processed, 1);
  const event = f.handled[0].event;
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.metadata), true);
  assert.equal(event.metadata.contextComplete, true);
  assert.equal(event.metadata.channelId, CHANNEL);
  assert.equal(event.metadata.isTopLevel, false);
  assert.equal(event.metadata.routingHint, "HUMAN_REVIEW");
  assert.equal(event.metadata.pollingMode, "DRAFT_ONLY");
  assert.equal(event.parentId, "old");
});

test("YouTube polling leaves all transient shared-runtime failure reasons retryable", async () => {
  const reasons = ["BRANCH_BUSY", "AI_EMPTY_OR_FAILED", "BRANCH_LEASE_ERROR", "GRAPH_UNAVAILABLE",
    "HUMAN_LOCK_STORE_UNAVAILABLE", "COOLDOWN_ACTIVE", "GLOBAL_LIMIT_REACHED", "COMMENT_PREPARATION_ERROR",
    "DURABLE_OR_DRAFT_PREPARATION_FAILED", "AUTH_CHANNEL_UNVERIFIED", "YOUTUBE_CONTEXT_UNVERIFIED"];
  for (const reason of reasons) {
    const f = fixture({ handler: async () => ({ status: "ignored", reason }) });
    await f.poller.runOnce(); f.setPages([page([thread("retry", { offset: 1000 })])]);
    const result = await f.poller.runOnce();
    assert.equal(result.deferred, 1, reason);
    assert.equal((await f.state()).seen.has("retry"), false, reason);
  }
});

test("YouTube active cycle rejects overlapping scans", async () => {
  const f = fixture();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const original = f.provider.listCommentThreads;
  f.provider.listCommentThreads = async (...args) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return original(...args);
  };
  const first = f.poller.runOnce(); await started;
  assert.equal((await f.poller.runOnce()).reason, "CYCLE_ALREADY_RUNNING");
  release(); assert.equal((await first).status, "ok");
});

test("YouTube ordinary seen writes cannot certify a baseline lost during the scan", async () => {
  const f = fixture(); await f.poller.runOnce();
  f.redis.loseSeen();
  await f.store.markSeen(key, ["already-handled-new"]);
  assert.equal((await f.state()).seenStatePresent, false);
  f.setPages([page([thread("old"), thread("new", { offset: 1000 })])]);
  assert.equal((await f.poller.runOnce()).stage, "re-prime");
  assert.equal(f.handled.length, 0);
});
