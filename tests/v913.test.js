const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manager = fs.readFileSync(path.join(__dirname, "../auth/threadsTokenManager.js"), "utf8");
const adapter = fs.readFileSync(path.join(__dirname, "../adapters/threadsAdapter.js"), "utf8");

test("v9.1.3 refresh uses official Threads refresh grant and never logs token", () => {
  assert.match(manager, /refresh_access_token/);
  assert.match(manager, /th_refresh_token/);
  assert.match(manager, /access_token: oldToken/);
  assert.doesNotMatch(manager, /console\.(?:log|error|warn)\([^\n]*oldToken/);
  assert.doesNotMatch(manager, /console\.(?:log|error|warn)\([^\n]*nextToken/);
});

test("v9.1.3 stores refreshed token and refresh timestamp in Redis", () => {
  assert.match(manager, /TOKEN_KEY/);
  assert.match(manager, /REFRESHED_AT_KEY/);
  assert.match(manager, /client\.set\(TOKEN_KEY, nextToken\)/);
  assert.match(manager, /client\.set\(REFRESHED_AT_KEY, String\(Date\.now\(\)\)\)/);
});

test("v9.1.3 defaults to daily checks and refresh around day 50", () => {
  assert.match(manager, /DEFAULT_CHECK_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(manager, /DEFAULT_REFRESH_AFTER_DAYS = 50/);
});

test("Threads adapter reads the live token for lookup/create/publish", () => {
  assert.match(adapter, /createThreadsTokenManager/);
  assert.match(adapter, /const getAccessToken = \(\) => tokenManager\.getToken\(\) \|\| accessToken/);
  assert.match(adapter, /createSafeReplyPublisher/);
  assert.match(adapter, /getAccessToken, userId/);
  const publisher = fs.readFileSync(path.join(__dirname, "../adapters/threadsReplyPublisher.js"), "utf8");
  assert.match(publisher, /getAccessToken\(\)/);
  assert.match(publisher, /Authorization: "Bearer " \+ token/);
});
