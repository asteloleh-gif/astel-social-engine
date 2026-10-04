const test = require("node:test");
const assert = require("node:assert/strict");
const { createYouTubeProvider } = require("../app/providers/youtubeProvider");
const { createYouTubeTokenManager, YOUTUBE_FORCE_SSL_SCOPE, mapYouTubeError } = require("../app/providers/youtubeTokenManager");
const { createYouTubeQuotaStore, youtubeQuotaDay, QUOTA_RESERVE_SCRIPT } = require("../app/providers/youtubeQuotaStore");
const { assertSocialProvider } = require("../app/providers/socialProvider");

const CHANNEL = "UC_ASAP_GTA6_TEST";
const account = Object.freeze({ key: "asap-gta6:youtube", platform: "youtube", userId: CHANNEL, username: "ASAP GTA6", enabled: true, dryRun: true });
const env = Object.freeze({ YOUTUBE_CLIENT_ID: "fixture-client", YOUTUBE_CLIENT_SECRET: "fixture-secret", YOUTUBE_REFRESH_TOKEN: "fixture-refresh", YOUTUBE_CHANNEL_ID: CHANNEL });
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, async json() { return data; } });
const comment = (id = "top-1", extra = {}) => ({ id, snippet: { textOriginal: "Trailer when?", textDisplay: "Trailer when?", videoId: "video-1", authorChannelId: { value: "UC_VIEWER" }, authorDisplayName: "Viewer", publishedAt: "2026-10-04T10:00:00Z", ...extra } });
const thread = (extra = {}) => ({ id: "thread-1", snippet: { channelId: CHANNEL, videoId: "video-1", totalReplyCount: 0, topLevelComment: comment(), ...extra } });
function tokenStub() {
  return { async getAccessToken() { return "fixture-access"; }, getGeneration: () => 1,
    health: () => ({ configured: true, tokenReady: true, writeScopeReady: true }) };
}
function quotaStub() {
  return { calls: [], isReady: () => true, async reserve(input) { this.calls.push(input); return { ok: true }; }, health: () => ({ connected: true }) };
}
function providerFixture({ fetchImpl, quota = quotaStub(), tokens = tokenStub(), ...options } = {}) {
  const calls = [];
  const provider = createYouTubeProvider({ account, env, tokenManager: tokens, quotaStore: quota,
    fetchImpl: async (url, opts) => {
      calls.push({ url: new URL(url), options: opts });
      if (fetchImpl) return fetchImpl(url, opts);
      if (new URL(url).pathname.endsWith("/channels")) return response(200, { items: [{ id: CHANNEL, snippet: { title: "ASAP GTA6" } }] });
      return response(200, { items: [] });
    }, ...options });
  return { provider, calls, quota };
}

function redisFixture() {
  const days = new Map();
  const client = { isReady: false, isOpen: false, keys: [], on() {},
    async connect() { this.isReady = true; this.isOpen = true; }, async ping() { return "PONG"; },
    async quit() { this.isReady = false; this.isOpen = false; },
    async hGetAll(key) { return days.get(key) || {}; },
    async eval(script, input) {
      assert.equal(script, QUOTA_RESERVE_SCRIPT);
      const key = input.keys[0];
      this.keys.push(key);
      const [cost, budget, operation, cap] = input.arguments;
      const value = days.get(key) || { used: 0, replies: 0, readUnits: 0, replyUnits: 0, moderationUnits: 0 };
      if (value.used + Number(cost) > Number(budget)) return [0, value.used, value.replies, 1];
      if (operation === "reply" && value.replies >= Number(cap)) return [0, value.used, value.replies, 2];
      value.used += Number(cost); value[`${operation}Units`] += Number(cost);
      if (operation === "reply") value.replies += 1;
      days.set(key, value);
      return [1, value.used, value.replies, 0];
    },
  };
  return { client, days };
}

// These tests make zero network calls. Every token/API/Redis interaction is a fixture.
test("YouTube provider normalizes top-level comments and common community getters", () => {
  const { provider } = providerFixture();
  assertSocialProvider(provider);
  const event = provider.normalizePolledComment(comment(), { topLevelCommentId: "top-1", videoId: "video-1", threadId: "thread-1", contextComplete: true });
  assert.equal(event.platform, "youtube");
  assert.equal(event.accountKey, "asap-gta6:youtube");
  assert.equal(event.rootId, "video-1");
  assert.equal(event.parentId, "video-1");
  assert.equal(event.metadata.topLevelCommentId, "top-1");
  assert.equal(event.metadata.authorChannelId, "UC_VIEWER");
  assert.equal(event.metadata.channelId, CHANNEL);
  assert.equal(event.metadata.isTopLevel, true);
  assert.equal(event.metadata.contextComplete, true);
  assert.equal(provider.getCommentId(event), "top-1");
  assert.equal(provider.getAuthorId(event), "UC_VIEWER");
  assert.equal(provider.getCommentText(event), "Trailer when?");
  assert.equal(provider.getParentId(event), "video-1");
  assert.equal(provider.getRootPostId(event), "video-1");
});

test("YouTube sibling replies retain flat top-level parent and creator context", () => {
  const { provider } = providerFixture();
  const event = provider.normalizePolledComment(comment("reply-1", { parentId: "top-1" }), { topLevelCommentId: "top-1", creatorAnswered: true, contextComplete: true });
  assert.equal(event.parentId, "top-1");
  assert.equal(event.metadata.isTopLevel, false);
  assert.equal(event.metadata.creatorReplied, true);
  assert.equal(event.metadata.creatorAnswered, true);
  assert.equal(provider.normalizePolledComment(comment("reply-1", { parentId: "wrong-top" }), { topLevelCommentId: "top-1" }), null);
});

test("YouTube normalization fails safely for malformed input and preserves self author IDs", () => {
  const { provider } = providerFixture();
  assert.equal(provider.normalizePolledComment({ id: "c", snippet: {} }), null);
  assert.equal(provider.normalizePolledComment({ snippet: { textOriginal: "x" } }), null);
  const event = provider.normalizePolledComment(thread({ topLevelComment: comment("mine", { authorChannelId: { value: CHANNEL } }) }));
  assert.equal(event.author.id, CHANNEL);
  assert.equal(event.metadata.contextComplete, false);
  assert.deepEqual(provider.parseWebhook({ entry: [{ id: CHANNEL }] }), []);
});

test("YouTube replies remain disabled with live approval env and never touch transport or quotas", async () => {
  const { provider, calls, quota } = providerFixture({ account: { ...account, dryRun: false }, env: { ...env, YOUTUBE_DRY_RUN: "false", YOUTUBE_REPLY_MODE: "LIVE_APPROVED" } });
  assert.deepEqual(await provider.reply("top-1", "hello"), { status: "failed", reason: "LIVE_TRANSPORT_DISABLED" });
  assert.deepEqual(await provider.publishReply("top-1", "hello", { approval: { valid: true } }), { status: "failed", reason: "LIVE_TRANSPORT_DISABLED" });
  assert.equal(calls.length, 0);
  assert.equal(quota.calls.length, 0);
  assert.equal(provider.capabilities.publishReplies, false);
  assert.equal(provider.health().liveTransportEnabled, false);
  assert.equal(provider.health().dryRun, true);
  assert.equal(provider.health().mode, "DRAFT_ONLY");
  for (const method of ["deleteComment", "setModerationStatus", "banAuthor", "insertComment"]) assert.equal(provider[method], undefined);
});

test("YouTube channel identity is exact, cached, refreshable, and secret-free", async () => {
  const { provider, calls, quota } = providerFixture();
  assert.equal(provider.health().identityVerified, false);
  const result = await provider.getAccountIdentity();
  assert.equal(result.status, "ok");
  assert.equal(result.identity.id, CHANNEL);
  assert.equal(result.idMatch, true);
  assert.equal(calls[0].url.searchParams.get("mine"), "true");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-access");
  assert.doesNotMatch(calls[0].url.toString(), /fixture-access/);
  await provider.getAccountIdentity();
  assert.equal(calls.length, 1);
  await provider.getAccountIdentity({ force: true });
  assert.equal(calls.length, 2);
  assert.equal(quota.calls.length, 2);
  assert.equal(provider.health().identityVerified, true);
  assert.doesNotMatch(JSON.stringify(provider.health()), /fixture-access|fixture-secret|fixture-refresh/);
});

test("YouTube pin rejects wrong, empty and ambiguous channels before comments are read", async () => {
  for (const items of [[], [{ id: "UC_FAMILY" }], [{ id: CHANNEL }, { id: "UC_FAMILY" }]]) {
    const { provider, calls } = providerFixture({ fetchImpl: async () => response(200, { items }) });
    const result = await provider.listCommentThreads();
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "AUTH_CHANNEL_MISMATCH");
    assert.equal(calls.length, 1);
    assert.equal(provider.health().identityVerified, false);
  }
});

test("YouTube missing/conflicting pins and disabled accounts never fetch", async () => {
  for (const [config, expected] of [
    [{ account: { ...account, userId: "" }, env: {} }, "CHANNEL_PIN_MISSING"],
    [{ env: { ...env, YOUTUBE_CHANNEL_ID: "UC_FAMILY" } }, "AUTH_CHANNEL_MISMATCH"],
    [{ account: { ...account, enabled: false } }, "MODULE_DISABLED"],
  ]) {
    const { provider, calls } = providerFixture(config);
    assert.equal((await provider.listCommentThreads()).reason, expected);
    assert.equal(calls.length, 0);
  }
});

test("YouTube identity cache expires and is tied to token generation", async () => {
  let now = Date.parse("2026-10-04T10:00:00Z");
  let generation = 1;
  const tokens = { ...tokenStub(), getGeneration: () => generation };
  const { provider, calls } = providerFixture({ tokens, clock: () => now });
  await provider.getAccountIdentity();
  generation = 2;
  assert.equal(provider.health().identityVerified, false);
  await provider.getAccountIdentity();
  now += 5 * 60000;
  assert.equal(provider.health().identityVerified, false);
  await provider.getAccountIdentity();
  assert.equal(calls.length, 3);
});

test("YouTube commentThreads uses pinned channel, plain text and one quota per page", async () => {
  const { provider, calls, quota } = providerFixture({ fetchImpl: async url => new URL(url).pathname.endsWith("/channels")
    ? response(200, { items: [{ id: CHANNEL }] }) : response(200, { items: [thread()], nextPageToken: "next-page" }) });
  const first = await provider.listCommentThreads({ maxResults: 1000 });
  assert.equal(first.status, "ok");
  assert.equal(first.items[0].id, "thread-1");
  const params = calls[1].url.searchParams;
  assert.equal(params.get("part"), "snippet,replies");
  assert.equal(params.get("allThreadsRelatedToChannelId"), CHANNEL);
  assert.equal(params.get("maxResults"), "100");
  assert.equal(params.get("moderationStatus"), "published");
  assert.equal(params.get("textFormat"), "plainText");
  assert.equal(params.get("order"), "time");
  await provider.listCommentThreads({ pageToken: first.nextPageToken });
  assert.equal(calls[2].url.searchParams.get("pageToken"), "next-page");
  assert.equal(quota.calls.length, 3); // channels.list plus two comment pages.
  assert.ok(quota.calls.every(call => call.units === 1 && call.operation === "read"));
  assert.ok(calls.every(call => call.options.method === "GET" && !call.url.pathname.includes("search")));
});

test("YouTube complete reply helper follows parent pagination and accounts for every read", async () => {
  const { provider, calls, quota } = providerFixture({ fetchImpl: async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/channels")) return response(200, { items: [{ id: CHANNEL }] });
    return response(200, { items: [comment(parsed.searchParams.get("pageToken") ? "r2" : "r1", { parentId: "top-1" })], nextPageToken: parsed.searchParams.get("pageToken") ? undefined : "p2" });
  } });
  const result = await provider.listAllReplies("top-1");
  assert.equal(result.status, "ok");
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map(item => item.id), ["r1", "r2"]);
  assert.equal(calls[1].url.searchParams.get("parentId"), "top-1");
  assert.equal(calls[2].url.searchParams.get("pageToken"), "p2");
  assert.equal(quota.calls.length, 3);
});

test("YouTube pagination loop and truncation are failures, never complete partial reply sets", async () => {
  const { provider } = providerFixture({ fetchImpl: async url => new URL(url).pathname.endsWith("/channels")
    ? response(200, { items: [{ id: CHANNEL }] }) : response(200, { items: [comment("r", { parentId: "top-1" })], nextPageToken: "same" }) });
  assert.equal((await provider.listAllReplies("top-1", { maxPages: 1 })).reason, "PAGINATION_LIMIT");
  const loop = await provider.listAllReplies("top-1");
  assert.equal(loop.reason, "PAGINATION_LOOP");
  assert.deepEqual(loop.items, []);
});

test("YouTube safe errors cover disabled comments, permissions and quota without raw messages", async () => {
  for (const [apiReason, expected] of [["commentsDisabled", "COMMENTS_DISABLED"], ["insufficientPermissions", "INSUFFICIENT_PERMISSIONS"], ["quotaExceeded", "QUOTA_EXCEEDED"], ["dailyLimitExceeded", "QUOTA_EXCEEDED"], ["fixture-access BAD", "INSUFFICIENT_PERMISSIONS"]]) {
    const { provider } = providerFixture({ fetchImpl: async url => new URL(url).pathname.endsWith("/channels")
      ? response(200, { items: [{ id: CHANNEL }] }) : response(403, { error: { message: "fixture-access private", errors: [{ reason: apiReason }] } }) });
    const result = await provider.listCommentThreads();
    assert.equal(result.reason, expected);
    assert.doesNotMatch(JSON.stringify({ result, health: provider.health() }), /fixture-access|private/);
  }
  assert.equal(mapYouTubeError(500, {}).reason, "API_UNAVAILABLE");
  assert.equal(mapYouTubeError(429, {}).reason, "RATE_LIMITED");
});

test("YouTube malformed/foreign thread and wrong-parent reply responses fail closed", async () => {
  for (const data of [{}, { items: null }, { items: [{}] }, { items: [thread()], nextPageToken: 22 }, { items: [thread({ totalReplyCount: -1 })] }]) {
    const { provider } = providerFixture({ fetchImpl: async url => new URL(url).pathname.endsWith("/channels") ? response(200, { items: [{ id: CHANNEL }] }) : response(200, data) });
    assert.equal((await provider.listCommentThreads()).reason, "MALFORMED_API_RESPONSE");
  }
  const foreign = providerFixture({ fetchImpl: async url => new URL(url).pathname.endsWith("/channels") ? response(200, { items: [{ id: CHANNEL }] }) : response(200, { items: [thread({ channelId: "UC_FAMILY" })] }) });
  assert.equal((await foreign.provider.listCommentThreads()).reason, "AUTH_CHANNEL_MISMATCH");
  const reply = providerFixture({ fetchImpl: async url => new URL(url).pathname.endsWith("/channels") ? response(200, { items: [{ id: CHANNEL }] }) : response(200, { items: [comment("r", { parentId: "other-top" })] }) });
  assert.equal((await reply.provider.listReplies("top-1")).reason, "MALFORMED_API_RESPONSE");
});

test("YouTube network/JSON failures sanitize errors and retain spent quota", async () => {
  for (const transport of [async () => { throw new Error("fixture-access private-url"); }, async () => ({ ok: true, async json() { throw new Error("fixture-access"); } })]) {
    const { provider, quota } = providerFixture({ fetchImpl: transport });
    const result = await provider.getAccountIdentity();
    assert.equal(result.status, "failed");
    assert.equal(quota.calls.length, 1);
    assert.doesNotMatch(JSON.stringify({ result, health: provider.health() }), /fixture-access|private-url/);
  }
});

test("YouTube quota denial or outage blocks API call without retry", async () => {
  for (const quota of [
    { async reserve() { return { ok: false, reason: "QUOTA_BUDGET_EXCEEDED" }; } },
    { async reserve() { throw new Error("redis://secret@host"); } },
    { isReady: () => false, async init() { throw new Error("redis://secret@host"); } },
  ]) {
    const { provider, calls } = providerFixture({ quota });
    const result = await provider.listCommentThreads();
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret@host/);
  }
});

test("YouTube 401 invalidates identity and never retries an API page automatically", async () => {
  let invalidated = false;
  const tokens = { ...tokenStub(), invalidate() { invalidated = true; } };
  const { provider, calls } = providerFixture({ tokens, fetchImpl: async url => new URL(url).pathname.endsWith("/channels")
    ? response(200, { items: [{ id: CHANNEL }] }) : response(401, { error: { message: "fixture-access" } }) });
  assert.equal((await provider.listCommentThreads()).reason, "AUTH_REQUIRED");
  assert.equal(invalidated, true);
  assert.equal(provider.health().identityVerified, false);
  assert.equal(calls.length, 2);
});

test("YouTube account/Meta credentials are never used as OAuth fallback", async () => {
  let calls = 0;
  const provider = createYouTubeProvider({ account: { ...account, accessToken: "other-platform-token" }, env: {},
    quotaStore: quotaStub(), fetchImpl: async () => { calls += 1; throw new Error("unexpected"); } });
  assert.equal((await provider.getAccountIdentity()).reason, "AUTH_CONFIG_MISSING");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(provider.health()), /other-platform-token/);
});

test("YouTube OAuth only refreshes an existing runtime grant and deduplicates concurrent refreshes", async () => {
  const calls = [];
  const manager = createYouTubeTokenManager({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(200, { access_token: "fixture-access", expires_in: 3600, token_type: "Bearer", scope: YOUTUBE_FORCE_SSL_SCOPE });
  } });
  assert.deepEqual(await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]), ["fixture-access", "fixture-access", "fixture-access"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.body.get("grant_type"), "refresh_token");
  assert.equal(calls[0].options.body.get("client_secret"), env.YOUTUBE_CLIENT_SECRET);
  assert.equal(calls[0].options.body.get("refresh_token"), env.YOUTUBE_REFRESH_TOKEN);
  assert.equal(manager.health().writeScopeReady, true);
  assert.equal((await manager.preflight({ forWrite: true })).status, "ok");
  assert.doesNotMatch(JSON.stringify(manager.health()), /fixture-access|fixture-secret|fixture-refresh/);
});

test("YouTube OAuth write scope readiness relies on token response, not env claims", async () => {
  for (const scope of [undefined, "https://www.googleapis.com/auth/youtube.readonly"]) {
    const manager = createYouTubeTokenManager({ env: { ...env, YOUTUBE_SCOPES: YOUTUBE_FORCE_SSL_SCOPE }, fetchImpl: async () => response(200, { access_token: "fixture-access", expires_in: 3600, token_type: "Bearer", scope }) });
    assert.equal((await manager.preflight()).status, "ok");
    assert.equal((await manager.preflight({ forWrite: true })).reason, "AUTH_SCOPE_MISSING");
    assert.equal(manager.health().writeScopeReady, false);
  }
});

test("YouTube OAuth refresh expiry clears old scope grant and never exposes auth errors", async () => {
  let now = 0;
  let count = 0;
  const manager = createYouTubeTokenManager({ env, clock: () => now, fetchImpl: async () => {
    count += 1;
    return response(200, { access_token: `fixture-access-${count}`, expires_in: 3600, token_type: "Bearer", ...(count === 1 ? { scope: YOUTUBE_FORCE_SSL_SCOPE } : {}) });
  } });
  await manager.getAccessToken();
  now = 3600 * 1000;
  assert.equal(manager.health().tokenReady, false);
  await manager.getAccessToken();
  assert.equal(count, 2);
  assert.equal(manager.health().writeScopeReady, false);
  const revoked = createYouTubeTokenManager({ env, fetchImpl: async () => response(400, { error: "invalid_grant", error_description: "fixture-refresh private" }) });
  assert.equal((await revoked.preflight()).reason, "AUTH_REVOKED");
  assert.doesNotMatch(JSON.stringify(revoked.health()), /fixture-refresh|private/);
});

test("YouTube OAuth rejects missing credentials/malformed tokens without insecure fallbacks", async () => {
  let calls = 0;
  const missing = createYouTubeTokenManager({ env: { YOUTUBE_ACCESS_TOKEN: "do-not-trust" }, fetchImpl: async () => { calls += 1; } });
  assert.equal((await missing.preflight()).reason, "AUTH_CONFIG_MISSING");
  assert.equal(calls, 0);
  for (const payload of [{}, { access_token: "a", token_type: "Bearer", expires_in: -1 }, { access_token: "a\r\nInjected", token_type: "Bearer", expires_in: 3600 }, { access_token: "a", token_type: "Basic", expires_in: 3600 }]) {
    const malformed = createYouTubeTokenManager({ env, fetchImpl: async () => response(200, payload) });
    assert.equal((await malformed.preflight()).reason, "AUTH_TOKEN_MALFORMED");
  }
});

test("YouTube quota date resets at Pacific midnight across DST", () => {
  assert.equal(youtubeQuotaDay(Date.parse("2026-10-04T06:59:59Z")), "2026-10-03");
  assert.equal(youtubeQuotaDay(Date.parse("2026-10-04T07:00:00Z")), "2026-10-04");
  assert.equal(youtubeQuotaDay(Date.parse("2026-12-04T07:59:59Z")), "2026-12-03");
  assert.equal(youtubeQuotaDay(Date.parse("2026-12-04T08:00:00Z")), "2026-12-04");
});

test("YouTube Redis quota reserves exactly 1/50 units and enforces daily budget and reply cap", async () => {
  const { client } = redisFixture();
  const quota = createYouTubeQuotaStore({ redisUrl: "redis://fixture", dailyBudget: 102, liveReplyDailyCap: 1, clientFactory: () => client });
  assert.equal((await quota.init()).ready, true);
  assert.equal((await quota.reserve({ operation: "read" })).used, 1);
  assert.equal((await quota.reserve({ operation: "reply" })).used, 51);
  assert.equal((await quota.reserve({ operation: "reply" })).reason, "LIVE_REPLY_CAP");
  assert.equal((await quota.reserve({ operation: "moderation" })).used, 101);
  assert.equal((await quota.reserve({ operation: "read" })).used, 102);
  assert.equal((await quota.reserve({ operation: "read" })).reason, "QUOTA_BUDGET_EXCEEDED");
  assert.equal((await quota.reserve({ operation: "reply", units: 1 })).reason, "INVALID_QUOTA_REQUEST");
  assert.equal((await quota.reserve({ operation: "search" })).reason, "INVALID_QUOTA_REQUEST");
  const snapshot = await quota.snapshot();
  assert.equal(snapshot.readUnits, 2);
  assert.equal(snapshot.replyUnits, 50);
  assert.equal(snapshot.moderationUnits, 50);
  await quota.close();
  assert.equal(quota.isReady(), false);
});

test("YouTube Redis quota is shared across restarts, modes and channels, with atomic bounded reservations", async () => {
  const { client } = redisFixture();
  const options = { redisUrl: "redis://fixture", dailyBudget: 10, clientFactory: () => client };
  const first = createYouTubeQuotaStore({ ...options, env: { YOUTUBE_DRY_RUN: "true", YOUTUBE_CHANNEL_ID: CHANNEL } });
  const second = createYouTubeQuotaStore({ ...options, env: { YOUTUBE_DRY_RUN: "false", YOUTUBE_CHANNEL_ID: "OTHER" } });
  await first.init(); await second.init();
  const reservations = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).reserve()));
  assert.equal(reservations.filter(result => result.ok).length, 10);
  assert.equal(new Set(client.keys).size, 1);
  assert.equal((await second.snapshot()).used, 10);
});

test("YouTube quota missing Redis, invalid budgets and Redis errors fail closed and sanitized", async () => {
  const missing = createYouTubeQuotaStore({ env: {} });
  assert.equal((await missing.init()).ready, false);
  assert.equal((await missing.reserve()).reason, "QUOTA_STORE_UNAVAILABLE");
  const { client } = redisFixture();
  const broken = createYouTubeQuotaStore({ redisUrl: "redis://secret@host", dailyBudget: "bad", clientFactory: () => client });
  await broken.init();
  assert.equal((await broken.reserve()).reason, "QUOTA_BUDGET_EXCEEDED");
  client.eval = async () => { throw new Error("redis://secret@host"); };
  assert.equal((await broken.reserve()).reason, "QUOTA_STORE_ERROR");
  assert.doesNotMatch(JSON.stringify(broken.health()), /secret@host/);
  client.eval = async () => [1, "unknown", 0, 0];
  assert.equal((await broken.reserve()).reason, "QUOTA_STORE_ERROR");
});
