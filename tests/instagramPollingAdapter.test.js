const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstagramAdapter } = require("../adapters/instagramAdapter");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

test("Instagram polling media read uses bearer auth and comments_count", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "secret-token",
    userId: "ig-1",
    accountKey: "a:instagram",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { data: [{ id: "m1", comments_count: 2 }] });
    },
  });

  const result = await adapter.listRecentMedia({ limit: 10 });
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 1);
  assert.match(calls[0].url, /\/v26\.0\/ig-1\/media\?/);
  assert.match(decodeURIComponent(calls[0].url), /comments_count/);
  assert.doesNotMatch(calls[0].url, /secret-token/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
});

test("Instagram polling comment read flattens replies and preserves media root", async () => {
  const adapter = createInstagramAdapter({
    accessToken: "token",
    userId: "ig-1",
    accountKey: "a:instagram",
    fetchImpl: async () => response(200, {
      data: [{
        id: "c1",
        text: "root",
        username: "buyer",
        timestamp: "2026-09-14T20:00:00Z",
        replies: { data: [{ id: "r1", text: "reply", username: "buyer2", timestamp: "2026-09-14T20:01:00Z" }] },
      }],
    }),
  });

  const result = await adapter.listComments("m1");
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].media.id, "m1");
  assert.equal(result.items[1].media.id, "m1");
  assert.equal(result.items[1].parent_id, "c1");

  const event = adapter.normalizePolledComment(result.items[1], "m1");
  assert.equal(event.sourceId, "r1");
  assert.equal(event.rootId, "m1");
  assert.equal(event.parentId, "c1");
  assert.equal(event.metadata.ingress, "polling");
  assert.equal(event.metadata.targetUserId, "ig-1");
});

test("Instagram polling read failures are safe and token-free", async () => {
  const adapter = createInstagramAdapter({
    accessToken: "secret-token",
    userId: "ig-1",
    accountKey: "a:instagram",
    fetchImpl: async () => response(403, { error: { code: 10, type: "OAuthException", message: "denied secret-token" } }),
  });

  const result = await adapter.listRecentMedia();
  assert.deepEqual(result, {
    status: "failed",
    reason: "META_REJECTED",
    code: 10,
    type: "OAuthException",
    items: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});
