const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstagramAdapter } = require("../adapters/instagramAdapter");
const { createInstagramProvider } = require("../app/providers/instagramProvider");
const { loadSocialAccounts, publicAccountView } = require("../app/accounts/accountConfig");
const { createInstagramCommentPoller } = require("../app/polling/instagramCommentPoller");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

function memoryStore() {
  return {
    async init() { return { status: "ok" }; },
    async isPrimed() { return false; },
    async markPrimed() {},
    async getSeen() { return new Set(); },
    async markSeen() {},
    async getMediaCounts() { return {}; },
    async setMediaCounts() {},
    health() { return { connected: true }; },
    async close() {},
  };
}

test("Instagram Facebook Login falls back to configured Facebook Page token", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "instagram-user-token",
    linkedPageAccessToken: "existing-page-token",
    userId: "instagram-login-id",
    username: "astel.us",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") return response(200, { data: [] });
      if (parsed.pathname === "/v26.0/me") {
        assert.equal(options.headers.Authorization, "Bearer existing-page-token");
        return response(200, {
          id: "page-id",
          instagram_business_account: { id: "facebook-linked-ig-id" },
        });
      }
      if (parsed.pathname === "/v26.0/facebook-linked-ig-id") {
        assert.equal(options.headers.Authorization, "Bearer existing-page-token");
        const fields = parsed.searchParams.get("fields");
        if (fields === "id,username") return response(200, { id: "facebook-linked-ig-id", username: "astel.us" });
        return response(200, {
          id: "facebook-linked-ig-id",
          username: "astel.us",
          media_count: 9,
        });
      }
      if (parsed.pathname === "/v26.0/facebook-linked-ig-id/media") {
        assert.equal(options.headers.Authorization, "Bearer existing-page-token");
        return response(200, { data: [{ id: "media-1", comments_count: 0 }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const identity = await adapter.getAccountIdentity();
  assert.equal(identity.status, "ok");
  assert.equal(identity.resolution, "configured_page_token");
  assert.equal(identity.identity.username, "astel.us");
  assert.equal(identity.identity.accountType, null);
  assert.equal(identity.identity.mediaCount, 9);
  assert.deepEqual(identity.diagnostics, {
    pagesVisible: 0,
    pagesWithInstagram: 0,
    identityLookupAttempts: 1,
    identityLookupSuccesses: 1,
    pageTokenFallbackConfigured: true,
    pageTokenFallbackAttempted: true,
    pageTokenFallbackHasInstagram: true,
  });

  const media = await adapter.listRecentMedia();
  assert.equal(media.status, "ok");
  assert.equal(media.items.length, 1);
  const identityFields = calls
    .filter(call => new URL(call.url).pathname === "/v26.0/facebook-linked-ig-id")
    .map(call => new URL(call.url).searchParams.get("fields"));
  assert.deepEqual(identityFields, ["id,username", "id,username,media_count"]);
  assert.equal(identityFields.some(fields => fields.includes("account_type")), false);
  assert.equal(calls.some(call => call.url.includes("instagram-user-token")), false);
  assert.equal(calls.some(call => call.url.includes("existing-page-token")), false);
});

test("Instagram Page token fallback fails closed with safe diagnostics when Page has no linked IG", async () => {
  const adapter = createInstagramAdapter({
    accessToken: "instagram-user-token",
    linkedPageAccessToken: "existing-page-token",
    userId: "instagram-login-id",
    username: "astel.us",
    authMode: "facebook_login",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") return response(200, { data: [] });
      if (parsed.pathname === "/v26.0/me") return response(200, { id: "page-id" });
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await adapter.getAccountIdentity();
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "PAGE_TOKEN_HAS_NO_LINKED_INSTAGRAM");
  assert.equal(result.diagnostics.pagesVisible, 0);
  assert.equal(result.diagnostics.pageTokenFallbackConfigured, true);
  assert.equal(result.diagnostics.pageTokenFallbackAttempted, true);
  assert.equal(result.diagnostics.pageTokenFallbackHasInstagram, false);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /token|page-id|instagram-login-id/);
});

test("Instagram account config keeps Facebook Page token private and provider passes it only internally", () => {
  const accounts = loadSocialAccounts({
    THREADS_USERNAME: "astel.us",
    THREADS_USER_ID: "threads-id",
    INSTAGRAM_USERNAME: "astel.us",
    INSTAGRAM_USER_ID: "ig-id",
    INSTAGRAM_ACCESS_TOKEN: "ig-token",
    INSTAGRAM_AUTH_MODE: "facebook_login",
    FACEBOOK_ACCESS_TOKEN: "facebook-page-token",
  });
  const account = accounts.find(item => item.platform === "instagram");
  assert.equal(account.linkedPageAccessToken, "facebook-page-token");
  assert.doesNotMatch(JSON.stringify(publicAccountView(account)), /facebook-page-token/);

  let adapterOptions = null;
  const provider = createInstagramProvider({
    account,
    adapterFactory: options => {
      adapterOptions = options;
      return {
        config: { apiVersion: "v26.0", authMode: "facebook_login" },
        parseWebhook() { return []; },
        async reply() { return { status: "published", id: "r1" }; },
      };
    },
  });
  assert.equal(adapterOptions.linkedPageAccessToken, "facebook-page-token");
  assert.doesNotMatch(JSON.stringify(provider.health()), /facebook-page-token/);
});

test("Instagram identity probe logs whitelisted auth diagnostics only", async () => {
  const provider = {
    platform: "instagram",
    accountKey: "astel.us:instagram",
    account: { enabled: true, accessToken: "secret", userId: "configured-id", username: "astel.us" },
    async getAccountIdentity() {
      return {
        status: "failed",
        reason: "PAGE_TOKEN_HAS_NO_LINKED_INSTAGRAM",
        code: null,
        diagnostics: {
          pagesVisible: 0,
          pagesWithInstagram: 0,
          identityLookupAttempts: 0,
          identityLookupSuccesses: 0,
          pageTokenFallbackConfigured: true,
          pageTokenFallbackAttempted: true,
          pageTokenFallbackHasInstagram: false,
          rawId: "must-not-log",
          token: "must-not-log-token",
        },
      };
    },
    async listRecentMedia() { return { status: "failed", reason: "PAGE_TOKEN_HAS_NO_LINKED_INSTAGRAM", items: [] }; },
  };
  const logs = [];
  const poller = createInstagramCommentPoller({
    provider,
    handler: async () => ({ status: "dry-run" }),
    store: memoryStore(),
    enabled: true,
    logger: { log(...args) { logs.push(args.join(" ")); }, error(...args) { logs.push(args.join(" ")); } },
  });

  const result = await poller.init();
  assert.equal(result.identityProbe.diagnostics.pageTokenFallbackAttempted, true);
  const joined = logs.join("\n");
  assert.match(joined, /pagesVisible/);
  assert.doesNotMatch(joined, /must-not-log/);
  assert.doesNotMatch(joined, /must-not-log-token/);
  await poller.stop();
});

for (const expected of ['astel.us', 'astel.u', 'leoakastel']) {
  for (const actual of ['astel.us', 'astel.u', 'leoakastel'].filter(name => name !== expected)) {
    test(`Page credential for ${actual} cannot publish as ${expected}`, async () => {
      let mutations = 0;
      const adapter = createInstagramAdapter({
        accessToken: 'mock-user-token', linkedPageAccessToken: 'mock-other-page-token',
        userId: 'configured-id', username: expected, accountKey: `${expected}:instagram`, authMode: 'facebook_login',
        fetchImpl: async (url, options) => {
          if (options.method !== 'GET') { mutations++; throw new Error('Unexpected mutation'); }
          const path = new URL(url).pathname;
          if (path.endsWith('/me/accounts')) return response(200, { data: [] });
          if (path.endsWith('/me')) return response(200, { id: 'other-page', instagram_business_account: { id: 'other-ig' } });
          if (path.endsWith('/other-ig')) return response(200, { id: 'other-ig', username: actual });
          throw new Error('Unexpected read');
        },
      });
      const result = await adapter.reply('source-comment', 'mock reply');
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'PAGE_TOKEN_INSTAGRAM_USERNAME_MISMATCH');
      assert.equal(mutations, 0);
    });
  }
}
