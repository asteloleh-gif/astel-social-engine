const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstagramCommentPoller } = require("../app/polling/instagramCommentPoller");

function memoryStore() {
  let primed = false;
  const seen = new Set();
  let counts = {};
  return {
    async init() { return { status: "ok" }; },
    async isPrimed() { return primed; },
    async markPrimed() { primed = true; },
    async getSeen() { return new Set(seen); },
    async markSeen(_accountKey, ids) { for (const id of ids) seen.add(String(id)); },
    async getMediaCounts() { return { ...counts }; },
    async setMediaCounts(_accountKey, next) { counts = { ...counts, ...next }; },
    health() { return { connected: true }; },
    async close() {},
    state() { return { primed, seen: new Set(seen), counts: { ...counts } }; },
  };
}

function providerFixture() {
  let media = [{ id: "m1", comments_count: 1 }];
  let comments = [{ id: "c-old", text: "old", username: "old-user", timestamp: "2026-09-14T20:00:00Z" }];
  return {
    platform: "instagram",
    accountKey: "astel.us:instagram",
    account: { enabled: true, accessToken: "token", userId: "ig-1" },
    async listRecentMedia() { return { status: "ok", items: media }; },
    async listComments() { return { status: "ok", items: comments }; },
    normalizePolledComment(comment, mediaId) {
      return {
        platform: "instagram",
        accountKey: "astel.us:instagram",
        type: "comment.created",
        sourceId: String(comment.id),
        rootId: mediaId,
        parentId: comment.parent_id || null,
        text: comment.text || "",
        author: { id: null, username: comment.username || null },
        surface: null,
        timestamp: comment.timestamp || null,
        metadata: { ingress: "polling" },
      };
    },
    setMedia(next) { media = next; },
    setComments(next) { comments = next; },
  };
}

test("Instagram polling primes existing comments without dispatching them", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createInstagramCommentPoller({
    provider,
    handler: async payload => { handled.push(payload); return { status: "dry-run" }; },
    store,
    enabled: true,
    intervalMs: 60000,
    logger: { log() {}, error() {} },
  });

  const result = await poller.runOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.stage, "prime");
  assert.equal(result.discovered, 1);
  assert.equal(handled.length, 0);
  assert.equal(store.state().seen.has("c-old"), true);
  assert.equal(store.state().counts.m1, 1);
});

test("Instagram polling re-primes when Development mode first returned no media", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  provider.setMedia([]);
  const poller = createInstagramCommentPoller({
    provider,
    handler: async payload => { handled.push(payload); return { status: "dry-run" }; },
    store,
    enabled: true,
    logger: { log() {}, error() {} },
  });

  const first = await poller.runOnce();
  assert.equal(first.stage, "prime");
  assert.equal(first.media, 0);

  provider.setMedia([{ id: "m1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old-1", timestamp: "2026-09-14T20:00:00Z" },
    { id: "c-old-2", timestamp: "2026-09-14T20:01:00Z" },
  ]);
  const second = await poller.runOnce();
  assert.equal(second.stage, "re-prime");
  assert.equal(second.discovered, 2);
  assert.equal(handled.length, 0);
  assert.equal(store.state().seen.has("c-old-1"), true);
  assert.equal(store.state().seen.has("c-old-2"), true);
});

test("Instagram polling dispatches only unseen comments after comments_count changes", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createInstagramCommentPoller({
    provider,
    handler: async payload => { handled.push(payload.event.sourceId); return { status: "dry-run" }; },
    store,
    enabled: true,
    intervalMs: 60000,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setMedia([{ id: "m1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old", text: "old", username: "old-user", timestamp: "2026-09-14T20:00:00Z" },
    { id: "c-new", text: "new", username: "buyer", timestamp: "2026-09-14T20:01:00Z" },
  ]);

  const result = await poller.runOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.discovered, 1);
  assert.equal(result.processed, 1);
  assert.deepEqual(handled, ["c-new"]);
  assert.equal(store.state().seen.has("c-new"), true);
  assert.equal(store.state().counts.m1, 2);
});

test("Instagram polling skips comment reads when counts are unchanged", async () => {
  const store = memoryStore();
  let commentReads = 0;
  const provider = providerFixture();
  const original = provider.listComments;
  provider.listComments = async (...args) => { commentReads += 1; return original(...args); };
  const poller = createInstagramCommentPoller({
    provider,
    handler: async () => ({ status: "dry-run" }),
    store,
    enabled: true,
    fullScanEvery: 10,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  assert.equal(commentReads, 1);
  await poller.runOnce();
  assert.equal(commentReads, 1);
});

test("Instagram polling periodic full scan catches comments even if comments_count is unchanged", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createInstagramCommentPoller({
    provider,
    handler: async payload => { handled.push(payload.event.sourceId); return { status: "dry-run" }; },
    store,
    enabled: true,
    fullScanEvery: 2,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setComments([
    { id: "c-old", timestamp: "2026-09-14T20:00:00Z" },
    { id: "c-new", timestamp: "2026-09-14T20:01:00Z" },
  ]);
  const second = await poller.runOnce();
  assert.equal(second.forceFullScan, true);
  assert.equal(second.discovered, 1);
  assert.deepEqual(handled, ["c-new"]);
});

test("Instagram polling does not mark transiently deferred comments as seen", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const poller = createInstagramCommentPoller({
    provider,
    handler: async () => ({ status: "ignored", reason: "DURABLE_STORE_UNAVAILABLE" }),
    store,
    enabled: true,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setMedia([{ id: "m1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old", timestamp: "2026-09-14T20:00:00Z" },
    { id: "c-new", timestamp: "2026-09-14T20:01:00Z" },
  ]);

  const result = await poller.runOnce();
  assert.equal(result.deferred, 1);
  assert.equal(store.state().seen.has("c-new"), false);
});

test("Instagram polling startup records safe account identity diagnostics", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  provider.account.username = "astel.us";
  provider.getAccountIdentity = async () => ({
    status: "ok",
    identity: {
      id: "app-scoped-secret-id",
      userId: "ig-1",
      username: "astel.us",
      accountType: "BUSINESS",
      mediaCount: 17,
    },
  });

  const logs = [];
  const poller = createInstagramCommentPoller({
    provider,
    handler: async () => ({ status: "dry-run" }),
    store,
    enabled: true,
    intervalMs: 60000,
    logger: {
      log(...args) { logs.push(args.join(" ")); },
      error(...args) { logs.push(args.join(" ")); },
    },
  });

  const result = await poller.init();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.identityProbe, {
    status: "ok",
    idMatch: true,
    usernameMatch: true,
    accountType: "BUSINESS",
    mediaCount: 17,
  });
  assert.deepEqual(poller.health().identityProbe, result.identityProbe);
  const joined = logs.join("\n");
  assert.match(joined, /Instagram identity probe/);
  assert.doesNotMatch(joined, /token/);
  assert.doesNotMatch(joined, /app-scoped-secret-id/);
  assert.doesNotMatch(joined, /ig-1/);
  await poller.stop();
});
