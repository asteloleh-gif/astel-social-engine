const { createInstagramAdapter } = require("../../adapters/instagramAdapter");
const { providerCapabilities } = require("./socialProvider");
const { createCommentCompatibility } = require("./commentCompatibility");

function createInstagramProvider({
  account,
  adapterFactory = createInstagramAdapter,
  apiVersion,
  baseUrl,
  fetchImpl,
} = {}) {
  if (!account) throw new Error("Instagram account config is required");
  if (account.platform !== "instagram") throw new Error(`Instagram provider cannot serve ${account.platform}`);

  const adapter = adapterFactory({
    accessToken: account.accessToken,
    userId: account.userId,
    username: account.username,
    linkedPageAccessToken: account.linkedPageAccessToken,
    authMode: account.authMode || undefined,
    accountKey: account.key,
    apiVersion,
    baseUrl,
    fetchImpl,
  });
  const compatibility = createCommentCompatibility({ adapter, account, platform: "instagram" });

  const provider = {
    platform: "instagram",
    accountKey: account.key,
    account,
    capabilities: providerCapabilities({
      webhooks: true,
      publishPosts: false,
      publishReplies: true,
      discovery: false,
      insights: false,
      images: false,
      video: false,
      carousel: false,
    }),

    parseWebhook: body => adapter.parseWebhook(body),
    publishReply: (parentId, text) => adapter.reply(parentId, text),
    health() {
      return {
        platform: "instagram",
        accountKey: account.key,
        configured: Boolean(account.userId && account.accessToken),
        enabled: account.enabled,
        dryRun: account.dryRun,
        apiVersion: adapter.config?.apiVersion || null,
        authMode: adapter.config?.authMode || null,
      };
    },
  };

  return Object.assign(provider, compatibility, adapter, {
    reply: (parentId, text) => provider.publishReply(parentId, text),
  });
}

module.exports = { createInstagramProvider };
