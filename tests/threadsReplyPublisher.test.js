"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSafeReplyPublisher, sanitizeMetaError } = require("../adapters/threadsReplyPublisher");

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function publisher(fetchImpl, overrides = {}) {
  return createSafeReplyPublisher({
    getAccessToken: () => "private-token",
    userId: "owner-123",
    fetchImpl,
    sleep: async () => {},
    logger: { log() {}, error() {} },
    ...overrides,
  });
}
test("success publishes once, through bearer auth without URL tokens", async () => {
  const calls = [];
  const p = publisher(async (url, opts) => {
    calls.push({ url, opts });
    return jsonResponse(200, { id: "reply-123" });
  });
  assert.deepEqual(await p.publishReply("container-1"), { status: "published", id: "reply-123" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /threads_publish\?creation_id=container-1/);
  assert.doesNotMatch(calls[0].url, /private-token/);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer private-token");
});
test("code 24: retry same container only when readiness is verified", async () => {
  const calls = [];
  let posts = 0;
  const p = publisher(async (url, opts) => {
    calls.push({ url, method: opts.method });
    if (opts.method === "GET") return jsonResponse(200, { status: "FINISHED" });
    posts++;
    return posts === 1
      ? jsonResponse(400, { error: { code: 24, error_subcode: 4279009 } })
      : jsonResponse(200, { id: "published-1" });
  });
  assert.equal((await p.publishReply("container-1")).status, "published");
  assert.equal(posts, 2);
  assert.equal(calls.filter(x => x.method === "POST").every(x => x.url.includes("creation_id=container-1")), true);
  assert.equal(calls.filter(x => x.method === "GET").length, 1);
});
test("code 24: never retry if container is already published", async () => {
  let posts = 0;
  const p = publisher(async (_url, opts) => {
    if (opts.method === "GET") return jsonResponse(200, { status: "PUBLISHED" });
    posts++;
    return jsonResponse(400, { error: { code: 24 } });
  });
  assert.equal((await p.publishReply("container-1")).status, "ambiguous");
  assert.equal(posts, 1);
});
test("code 24: unknown status is held, not retried", async () => {
  let posts = 0;
  const p = publisher(async (_url, opts) => {
    if (opts.method === "GET") return jsonResponse(403, { error: { code: 10 } });
    posts++;
    return jsonResponse(400, { error: { code: 24 } });
  });
  assert.equal((await p.publishReply("container-1")).reason, "CONTAINER_STATUS_UNVERIFIED");
  assert.equal(posts, 1);
});
test("non-24 Meta rejection is definitive", async () => {
  let calls = 0;
  const p = publisher(async () => {
    calls++;
    return jsonResponse(403, { error: { code: 200, message: "Permission denied" } });
  });
  const result = await p.publishReply("container-1");
  assert.equal(result.status, "failed");
  assert.equal(result.code, 200);
  assert.equal(calls, 1);
});
test("server and network failures are ambiguous, never blindly retried", async () => {
  let calls = 0;
  const p = publisher(async () => {
    calls++;
    return jsonResponse(500, { error: { code: 2 } });
  });
  assert.equal((await p.publishReply("container-1")).status, "ambiguous");
  assert.equal(calls, 1);
  const q = publisher(async () => { throw new Error("ECONNRESET"); });
  assert.equal((await q.publishReply("container-2")).status, "ambiguous");
});
test("in-progress code 24 checks readiness again before retry", async () => {
  let posts = 0, checks = 0;
  const p = publisher(async (_url, opts) => {
    if (opts.method === "GET") {
      checks++;
      return jsonResponse(200, { status: checks === 1 ? "IN_PROGRESS" : "FINISHED" });
    }
    posts++;
    return posts === 1 ? jsonResponse(400, { error: { code: 24 } }) : jsonResponse(200, { id: "ok" });
  });
  assert.equal((await p.publishReply("container-3")).status, "published");
  assert.equal(checks, 2);
  assert.equal(posts, 2);
});
test("sanitized errors exclude credentials and extra fields", () => {
  const value = JSON.stringify(sanitizeMetaError({
    code: 24, error_subcode: 4279009,
    message: "access_token=SECRET& Bearer PASSWORD",
    raw_token: "LEAK",
  }));
  assert.doesNotMatch(value, /SECRET|PASSWORD|LEAK/);
  assert.match(value, /4279009/);
});
