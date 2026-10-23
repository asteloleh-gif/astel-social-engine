const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstagramAdapter } = require("../adapters/instagramAdapter");
const { createInstagramProvider } = require("../app/providers/instagramProvider");
const { loadSocialAccounts } = require("../app/accounts/accountConfig");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

test("Instagram Facebook Login resolves linked Page token and probes IG identity safely", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "secret-user-token",
    userId: "ig-123",
    accountKey: "astel.us:instagram",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") {
        return response(200, {
          data: [
            {
              id: "page-1",
              name: "Astel Page",
              access_token: "secret-page-token",
              instagram_business_account: { id: "ig-123" },
            },
          ],
        });
      }
      if (parsed.pathname === "/v26.0/ig-123") {
        return response(200, {
          id: "ig-123",
          username: "astel.us",
          media_count: 42,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await adapter.getAccountIdentity();
  assert.deepEqual(result, {
    status: "ok",
    identity: {
      id: "ig-123",
      userId: "ig-123",
      username: "astel.us",
      accountType: null,
      mediaCount: 42,
    },
  });
  assert.equal(adapter.config.authMode, "facebook_login");
  assert.equal(adapter.config.baseUrl, "https://graph.facebook.com");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-user-token");
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-page-token");
  assert.equal(new URL(calls[1].url).searchParams.get("fields"), "id,username,media_count");
  assert.equal(new URL(calls[1].url).searchParams.get("fields").includes("account_type"), false);
  assert.equal(calls.some(call => call.url.includes("secret-user-token")), false);
  assert.equal(calls.some(call => call.url.includes("secret-page-token")), false);
});

test("Instagram Facebook Login discovers Facebook-linked IG id by username when configured id differs", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "secret-user-token",
    userId: "instagram-login-scoped-id",
    username: "@astel.us",
    accountKey: "astel.us:instagram",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") {
        return response(200, {
          data: [
            {
              id: "page-other",
              access_token: "other-page-token",
              instagram_business_account: { id: "ig-other" },
            },
            {
              id: "page-astel",
              access_token: "astel-page-token",
              instagram_business_account: { id: "facebook-linked-ig-id" },
            },
          ],
        });
      }
      if (parsed.pathname === "/v26.0/ig-other") {
        return response(200, { id: "ig-other", username: "someone.else" });
      }
      if (parsed.pathname === "/v26.0/facebook-linked-ig-id") {
        const fields = parsed.searchParams.get("fields");
        if (fields === "id,username") {
          return response(200, { id: "facebook-linked-ig-id", username: "astel.us" });
        }
        return response(200, {
          id: "facebook-linked-ig-id",
          username: "astel.us",
          account_type: "BUSINESS",
          media_count: 17,
        });
      }
      if (parsed.pathname === "/v26.0/facebook-linked-ig-id/media") {
        return response(200, { data: [{ id: "media-1", comments_count: 0 }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const identity = await adapter.getAccountIdentity();
  assert.equal(identity.status, "ok");
  assert.equal(identity.identity.userId, "facebook-linked-ig-id");
  assert.equal(identity.identity.username, "astel.us");
  assert.equal(identity.identity.mediaCount, 17);

  const media = await adapter.listRecentMedia();
  assert.equal(media.status, "ok");
  assert.equal(media.items.length, 1);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/v26.0/me/accounts").length, 1);
  const mediaCall = calls.find(call => new URL(call.url).pathname === "/v26.0/facebook-linked-ig-id/media");
  assert.ok(mediaCall);
  assert.equal(mediaCall.options.headers.Authorization, "Bearer astel-page-token");
  assert.equal(calls.some(call => call.url.includes("secret-user-token")), false);
  assert.equal(calls.some(call => call.url.includes("astel-page-token")), false);
});

test("Instagram Facebook Login caches Page token and uses it for media reads", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "user-token",
    userId: "ig-123",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") {
        return response(200, {
          data: [{
            id: "page-1",
            access_token: "page-token",
            instagram_business_account: { id: "ig-123" },
          }],
        });
      }
      if (parsed.pathname === "/v26.0/ig-123/media") {
        return response(200, { data: [{ id: "media-1", comments_count: 2 }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const first = await adapter.listRecentMedia({ limit: 5 });
  const second = await adapter.listRecentMedia({ limit: 5 });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/v26.0/me/accounts").length, 1);
  const mediaCalls = calls.filter(call => new URL(call.url).pathname === "/v26.0/ig-123/media");
  assert.equal(mediaCalls.length, 2);
  assert.equal(mediaCalls.every(call => call.options.headers.Authorization === "Bearer page-token"), true);
});

test("Instagram Facebook Login fails closed when no Page is linked to configured IG account", async () => {
  const adapter = createInstagramAdapter({
    accessToken: "user-token",
    userId: "ig-expected",
    authMode: "facebook_login",
    fetchImpl: async () => response(200, {
      data: [{
        id: "page-1",
        access_token: "page-token",
        instagram_business_account: { id: "ig-other" },
      }],
    }),
  });

  assert.deepEqual(await adapter.getAccountIdentity(), {
    status: "failed",
    reason: "LINKED_PAGE_NOT_FOUND",
    code: null,
  });
  const media = await adapter.listRecentMedia();
  assert.equal(media.status, "failed");
  assert.equal(media.reason, "LINKED_PAGE_NOT_FOUND");
  assert.deepEqual(media.items, []);
});

test("Instagram auth mode loads from env and provider exposes only safe mode metadata", () => {
  const accounts = loadSocialAccounts({
    THREADS_USERNAME: "astel.us",
    THREADS_USER_ID: "threads-1",
    INSTAGRAM_USERNAME: "astel.us",
    INSTAGRAM_USER_ID: "ig-123",
    INSTAGRAM_ACCESS_TOKEN: "secret-user-token",
    INSTAGRAM_AUTH_MODE: "facebook_login",
  });
  const account = accounts.find(item => item.platform === "instagram");
  assert.equal(account.authMode, "facebook_login");

  let adapterOptions = null;
  const provider = createInstagramProvider({
    account,
    adapterFactory: options => {
      adapterOptions = options;
      return {
        config: { apiVersion: "v26.0", authMode: options.authMode, baseUrl: "https://graph.facebook.com" },
        parseWebhook() { return []; },
        async reply() { return { status: "published", id: "r1" }; },
      };
    },
  });
  assert.equal(adapterOptions.username, "astel.us");
  assert.equal(provider.health().authMode, "facebook_login");
  assert.doesNotMatch(JSON.stringify(provider.health()), /secret-user-token/);
});
