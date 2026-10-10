const { createThreadsAdapter } = require("../../adapters/threadsAdapter");
const { createThreadsPostPublisher } = require("../../adapters/threadsPostPublisher");
const { createThreadsInsightsAdapter } = require("../../adapters/threadsInsightsAdapter");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../events/socialEvent");
const { providerCapabilities } = require("./socialProvider");

function createThreadsProvider({
  account,
  adapterFactory = createThreadsAdapter,
  postPublisherFactory = createThreadsPostPublisher,
  insightsAdapterFactory = createThreadsInsightsAdapter,
} = {}) {
  if (!account) throw new Error("Threads account config is required");
  if (account.platform !== "threads") throw new Error(`Threads provider cannot serve ${account.platform}`);

  const adapter = adapterFactory({
    accessToken: account.accessToken,
    userId: account.userId,
  });
  const postPublisher = postPublisherFactory({
    tokenManager: adapter.tokenManager,
    fallbackAccessToken: account.accessToken,
  });
  const insights = insightsAdapterFactory({
    tokenManager: adapter.tokenManager,
    fallbackAccessToken: account.accessToken,
  });
  const publishReply = (parentId, text) => adapter.reply(parentId, text);

  const provider = {
    platform: "threads",
    accountKey: account.key,
    account,
    capabilities: providerCapabilities({
      webhooks: true,
      publishPosts: true,
      publishReplies: true,
      discovery: true,
      insights: true,
      images: false,
      video: false,
      carousel: false,
    }),

    parseWebhook: body => adapter.parseWebhook(body),
    normalizeWebhookEvent(native) {
      const sourceId = adapter.getCommentId(native);
      if (!sourceId) return null;
      return createSocialEvent({
        platform: "threads",
        accountKey: account.key,
        type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
        sourceId,
        rootId: adapter.getRootPostId(native),
        parentId: adapter.getParentId(native),
        text: adapter.getCommentText(native) || "",
        author: {
          id: adapter.getAuthorId(native),
          username: adapter.getAuthorUsername(native),
        },
        surface: "THREADS",
        timestamp: native?.timestamp || null,
        metadata: {
          webhookTargetId: adapter.getWebhookTargetId(native),
          parentAuthorId: adapter.getParentAuthorId(native),
          parentAuthorUsername: adapter.getParentAuthorUsername(native),
        },
      });
    },
    publishPost: (content, context) => postPublisher.publishPost(content, context),
    publishReply,
    getPostInsights: (postId, options) => insights.getPostInsights(postId, options),
    getAccountInsights: options => insights.getAccountInsights(options),
    listRecentPosts: options => insights.listRecentPosts(options),
    health() {
      return {
        platform: "threads",
        accountKey: account.key,
        configured: Boolean(account.userId && (account.accessToken || adapter.tokenManager?.getToken?.())),
        insights: true,
      };
    },
  };

  // Compatibility surface for the existing real-time Reply Engine. The native
  // adapter methods remain available while cross-platform routing uses the
  // normalized SocialEvent side channel above. Re-apply publishReply/reply after
  // copying adapter methods because the adapter also exposes an internal
  // publishReply(creationId) method with a different contract.
  return Object.assign(provider, adapter, {
    normalizeWebhookEvent: provider.normalizeWebhookEvent,
    publishPost: provider.publishPost,
    publishReply,
    reply: publishReply,
  });
}

module.exports = { createThreadsProvider };
