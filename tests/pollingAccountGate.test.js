"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("disabled Facebook account cannot start polling just because polling flag is on", () => {
  const envKeys = ["FACEBOOK_POLLING_ENABLED", "FACEBOOK_ENABLED", "FACEBOOK_USER_ID", "FACEBOOK_USERNAME", "FACEBOOK_ACCESS_TOKEN"];
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  try {
    process.env.FACEBOOK_POLLING_ENABLED = "true";
    process.env.FACEBOOK_ENABLED = "false";
    process.env.FACEBOOK_USER_ID = "page123";
    process.env.FACEBOOK_USERNAME = "disabled-page";
    process.env.FACEBOOK_ACCESS_TOKEN = "not-a-real-secret";
    const runtime = require("../server-meta-runtime");
    const fb = runtime.facebookPollers.find(item => item.health().accountKey.endsWith(":facebook"));
    assert.ok(fb, "configured Facebook provider must be present");
    assert.equal(fb.health().enabled, false);
    assert.equal(fb.health().running, false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
