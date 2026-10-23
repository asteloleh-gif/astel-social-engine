const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountConfig } = require("../app/accounts/accountConfig");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../app/events/socialEvent");
const { createInstagramAdapter } = require("../adapters/instagramAdapter");
const { createInstagramProvider } = require("../app/providers/instagramProvider");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

function instagramAccount() {
  return createAccountConfig({
    key: "astel-u:instagram",
    brand: "astel-u",
    platform: "instagram",
    username: "astel.u",
    userId: "17841400000000000",
    accessToken: "secret-instagram-token",
    language: "ru",
  });
}

test("normalized social event is immutable and account scoped", () => {
  const event = createSocialEvent({
    platform: "Instagram",
    accountKey: "ASTEL-U:INSTAGRAM",
    type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
    sourceId: "c1",
    rootId: "m1",
    author: { id: "u1", username: "buyer" },
  });
  assert.equal(event.platform, "instagram");
  assert.equal(event.accountKey, "astel-u:instagram");
  assert.equal(event.sourceId, "c1");
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.author), true);
});

test("Instagram webhook parser emits normalized top-level comment event", () => {
  const adapter = createInstagramAdapter({ authMode: "instagram_login",
    accessToken: "token",
    userId: "ig-1",
    accountKey: "astel-u:instagram",
  });
  const events = adapter.parseWebhook({
    object: "instagram",
    entry: [{
      id: "ig-1",
      changes: [{
        field: "comments",
        value: {
          id: "comment-1",
          text: "Price?",
          from: { id: "user-1", username: "buyer" },
          media: { id: "media-1", media_product_type: "FEED" },
          timestamp: "2026-09-13T05:00:00+0000",
        },
      }],
    }],
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    platform: "instagram",
    accountKey: "astel-u:instagram",
    type: "comment.created",
    sourceId: "comment-1",
    rootId: "media-1",
    parentId: null,
    text: "Price?",
    author: { id: "user-1", username: "buyer" },
    surface: "FEED",
    timestamp: "2026-09-13T05:00:00+0000",
    metadata: { webhookField: "comments", targetUserId: "ig-1" },
  });
});

test("Instagram webhook parser preserves parent comment and supports live comments", () => {
  const adapter = createInstagramAdapter({ authMode: "instagram_login", accessToken: "token", userId: "ig-1", accountKey: "a:instagram" });
  const [event] = adapter.parseWebhook({
    object: "instagram",
    entry: [{ id: "ig-1", changes: [{ field: "live_comments", value: {
      id: "reply-1", parent_id: "comment-1", text: "nested", from: { id: "u2", username: "viewer" }, media: { id: "live-1", media_product_type: "LIVE" },
    } }] }],
  });
  assert.equal(event.parentId, "comment-1");
  assert.equal(event.metadata.webhookField, "live_comments");
});

test("Instagram webhook parser ignores another account and unrelated fields", () => {
  const adapter = createInstagramAdapter({ authMode: "instagram_login", accessToken: "token", userId: "ig-1", accountKey: "a:instagram" });
  assert.deepEqual(adapter.parseWebhook({ object: "instagram", entry: [{ id: "ig-2", changes: [{ field: "comments", value: { id: "c" } }] }] }), []);
  assert.deepEqual(adapter.parseWebhook({ object: "instagram", entry: [{ id: "ig-1", changes: [{ field: "messages", value: { id: "m" } }] }] }), []);
  assert.deepEqual(adapter.parseWebhook({ object: "page", entry: [{ id: "ig-1", changes: [{ field: "comments", value: { id: "c" } }] }] }), []);
});

test("Instagram reply publishes once with bearer auth and no token in URL", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({ authMode: "instagram_login",
    accessToken: "secret-token",
    userId: "ig-1",
    accountKey: "a:instagram",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { id: "published-comment-1" });
    },
  });
  const result = await adapter.reply("comment-1", "hello");
  assert.deepEqual(result, { status: "published", id: "published-comment-1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v26\.0\/comment-1\/replies$/);
  assert.doesNotMatch(calls[0].url, /secret-token/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].options.body.get("message"), "hello");
});

test("Instagram reply fails closed on deterministic Meta rejection", async () => {
  const adapter = createInstagramAdapter({ authMode: "instagram_login",
    accessToken: "token", userId: "ig-1", accountKey: "a:instagram",
    fetchImpl: async () => response(400, { error: { code: 10, message: "permission denied" } }),
  });
  assert.deepEqual(await adapter.reply("comment-1", "hello"), { status: "failed", reason: "META_REJECTED", code: 10 });
});

test("Instagram reply never retries an ambiguous mutation outcome", async () => {
  let networkCalls = 0;
  const networkAdapter = createInstagramAdapter({ authMode: "instagram_login",
    accessToken: "token", userId: "ig-1", accountKey: "a:instagram",
    fetchImpl: async () => { networkCalls += 1; throw new Error("timeout"); },
  });
  assert.deepEqual(await networkAdapter.reply("comment-1", "hello"), { status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" });
  assert.equal(networkCalls, 1);

  let serverCalls = 0;
  const serverAdapter = createInstagramAdapter({ authMode: "instagram_login",
    accessToken: "token", userId: "ig-1", accountKey: "a:instagram",
    fetchImpl: async () => { serverCalls += 1; return response(503, { error: { code: 2 } }); },
  });
  assert.deepEqual(await serverAdapter.reply("comment-1", "hello"), { status: "ambiguous", reason: "SERVER_OUTCOME_UNKNOWN" });
  assert.equal(serverCalls, 1);
});

test("Instagram provider satisfies common boundary without exposing credentials", async () => {
  const account = instagramAccount();
  const provider = createInstagramProvider({
    account,
    adapterFactory: ({ accountKey }) => ({
      config: { apiVersion: "v26.0" },
      parseWebhook() { return []; },
      async reply(parentId, text) { return { status: "published", id: `${parentId}:${text}` }; },
    }),
  });
  assert.equal(provider.platform, "instagram");
  assert.equal(provider.accountKey, "astel-u:instagram");
  assert.equal(provider.capabilities.webhooks, true);
  assert.equal(provider.capabilities.publishReplies, true);
  assert.equal(provider.capabilities.publishPosts, false);
  assert.deepEqual(await provider.publishReply("c1", "ok"), { status: "published", id: "c1:ok" });
  assert.equal(provider.health().configured, true);
  assert.doesNotMatch(JSON.stringify(provider.health()), /secret-instagram-token/);
});
