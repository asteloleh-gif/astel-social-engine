/**
 * Astel Social Engine — unified Meta webhook entrypoint.
 *
 * This entrypoint deliberately reuses the proven Threads Community Engine from
 * server.js and adds account-scoped Instagram/Facebook runtimes around it. The
 * legacy server remains intact as a one-line rollback target.
 */
const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const legacy = require("./server");
const { createMetaWebhookRouter } = require("./app/webhooks/metaWebhookRouter");
const { createMetaWebhookSignature, captureMetaRawBody } = require("./app/webhooks/metaWebhookSignature");
const { createCommunityRuntime } = require("./app/community/createCommunityRuntime");
const { createYouTubeCommunityRuntime } = require("./app/community/createYouTubeCommunityRuntime");
const { createPlatformReplyGenerator } = require("./app/community/createPlatformReplyGenerator");
const { createPublishRepository } = require("./app/publishing/publishRepository");
const { createDurablePublishRepository } = require("./app/publishing/durablePublishRepository");
const { createPublishEngine } = require("./app/publishing/publishEngine");
const { createPostgresStore } = require("./app/db/postgresStore");
const { createDurableRepository } = require("./app/db/durableRepository");
const { createAnalyticsRepository } = require("./app/analytics/analyticsRepository");
const { createAnalyticsEngine } = require("./app/analytics/analyticsEngine");
const { createContentRuntime } = require("./app/content/contentRuntime");
const { createContentControlStore } = require("./app/content/contentControlStore");
const { createContentControl } = require("./app/content/contentControl");
const { createContentControlRouter } = require("./app/content/contentControlRouter");
const { createHyperCrewOrchestrator } = require("./app/orchestration/hyperCrewOrchestrator");
const { createInternalAnalyticsRouter } = require("./app/analytics/internalAnalyticsRouter");
const { loadProactiveConfig } = require("./config/proactive");

const app = express();
app.use(bodyParser.json({ verify: captureMetaRawBody }));

const {
  REDIS_URL,
  PORT = 3000,
  MAX_MEMORY_MESSAGES = "8",
  MAX_MEMORY_TOKENS = "1000",
  PROACTIVE_PERMISSION_PROBE = "false",
  OPENAI_MODEL = "gpt-5.6-luna",
  PUBLISH_ENGINE_ENABLED = "false",
  PUBLISH_ENGINE_DRY_RUN = "true",
  PUBLISH_POLL_INTERVAL_MS = "5000",
  PUBLISH_BATCH_SIZE = "5",
  PUBLISH_LEASE_MS = "60000",
  ANALYTICS_ENGINE_ENABLED = "false",
  ANALYTICS_INTERVAL_MS = "21600000",
  ANALYTICS_MAX_POSTS_PER_ACCOUNT = "25",
  ANALYTICS_LOOKBACK_DAYS = "30",
  CONTENT_PIPELINE_ENABLED = "false",
  CONTENT_ALLOW_LIVE_SCHEDULING = "false",
  CONTENT_CONTROL_API_ENABLED = "false",
  CONTENT_CONTROL_API_TOKEN = "",
  CONTENT_CONTROL_REDIS_NAMESPACE = "astel:content-control:v1",
  CONTENT_CONTROL_IDEMPOTENCY_TTL_SECONDS = "86400",
  HYPER_CREW_ENABLED = "false",
  ANALYTICS_API_TOKEN = "",
} = process.env;

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

const platformReplyGenerator = createPlatformReplyGenerator({ env: process.env });
const proactiveConfig = loadProactiveConfig();
const secondaryCommunity = new Map();
const postgresStore = createPostgresStore();
const durable = createDurableRepository({ store: postgresStore });
const analyticsRepository = createAnalyticsRepository({ store: postgresStore, durable });
let lastDurableProjectionError = null;

async function persistDurable(label, fn) {
  if (!durable.isReady()) return false;
  try {
    await fn();
    lastDurableProjectionError = null;
    return true;
  } catch (error) {
    lastDurableProjectionError = error?.message || String(error);
    console.error("Durable projection error", JSON.stringify({ label, error: lastDurableProjectionError }));
    return false;
  }
}

for (const provider of legacy.socialContext.providers.list()) {
  if (provider.platform === "threads") continue;
  if (provider.platform === "youtube") {
    secondaryCommunity.set(provider.accountKey, createYouTubeCommunityRuntime({
      provider, redisUrl: REDIS_URL, policy: legacy.policy, durable,
      generateReply: platformReplyGenerator,
      // No Meta KB fallback: approved ASAP context is injected separately when available.
      getContext: async () => "",
      mode: process.env.YOUTUBE_REPLY_MODE || "DRAFT_ONLY",
    }));
    continue;
  }
  const runtime = createCommunityRuntime({
    provider,
    redisUrl: REDIS_URL,
    policy: legacy.policy,
    getContext: legacy.getContext,
    generateReply: platformReplyGenerator,
    canPublish: async () => {
      if (!postgresStore.isRequired()) return true;
      try { await postgresStore.query("SELECT 1 AS ok"); return true; }
      catch (_) { return false; }
    },
    isKnownBotReply: async replyId => {
      if (!replyId || !durable.isReady()) return false;
      return durable.hasReplyId({ accountKey: provider.accountKey, replyId });
    },
    recordConfirmedBotReply: async ({ sourceCommentId, replyId, replyText }) => {
      if (!replyId || !durable.isReady()) return false;
      return durable.recordReply({
        accountKey: provider.accountKey,
        sourceCommentId,
        replyId,
        status: "PUBLISHED_PENDING_ACCOUNTING",
        text: replyText,
        publishedAt: new Date(),
        metadata: { platform: provider.platform, safetyQuarantine: true },
      });
    },
    maxMemoryMessages: Number(MAX_MEMORY_MESSAGES),
    maxMemoryTokens: Number(MAX_MEMORY_TOKENS),
  });
  secondaryCommunity.set(provider.accountKey, runtime);
}

const hotPublishRepository = createPublishRepository({ redisUrl: REDIS_URL });
const publishRepository = createDurablePublishRepository({ hotRepository: hotPublishRepository, durable });
const publishEngine = createPublishEngine({
  providerRegistry: legacy.socialContext.providers,
  repository: publishRepository,
  enabled: bool(PUBLISH_ENGINE_ENABLED, false),
  dryRun: bool(PUBLISH_ENGINE_DRY_RUN, true),
  pollIntervalMs: Number(PUBLISH_POLL_INTERVAL_MS),
  batchSize: Number(PUBLISH_BATCH_SIZE),
  leaseMs: Number(PUBLISH_LEASE_MS),
});
const internalAnalyticsRouter = createInternalAnalyticsRouter({ store: postgresStore, token: ANALYTICS_API_TOKEN });
if (ANALYTICS_API_TOKEN) app.use("/internal/analytics", internalAnalyticsRouter);

const analyticsEngine = createAnalyticsEngine({
  providerRegistry: legacy.socialContext.providers,
  repository: analyticsRepository,
  enabled: bool(ANALYTICS_ENGINE_ENABLED, false),
  intervalMs: Number(ANALYTICS_INTERVAL_MS),
  maxPostsPerAccount: Number(ANALYTICS_MAX_POSTS_PER_ACCOUNT),
  lookbackDays: Number(ANALYTICS_LOOKBACK_DAYS),
});
const contentRuntime = createContentRuntime({
  enabled: bool(CONTENT_PIPELINE_ENABLED, false),
  allowLiveScheduling: bool(CONTENT_ALLOW_LIVE_SCHEDULING, false),
  redisUrl: REDIS_URL,
  postgresStore,
  durable,
  publishEngine,
  providerRegistry: legacy.socialContext.providers,
  env: process.env,
});
const hyperCrew = createHyperCrewOrchestrator({
  enabled: bool(HYPER_CREW_ENABLED, false),
  contentRuntime,
  durable,
});
const contentControlStore = createContentControlStore({
  redisUrl: REDIS_URL,
  namespace: CONTENT_CONTROL_REDIS_NAMESPACE,
  ttlSeconds: Number(CONTENT_CONTROL_IDEMPOTENCY_TTL_SECONDS),
});
const contentControl = createContentControl({
  enabled: bool(CONTENT_CONTROL_API_ENABLED, false),
  token: CONTENT_CONTROL_API_TOKEN,
  runtime: contentRuntime,
  store: contentControlStore,
});
if (bool(CONTENT_CONTROL_API_ENABLED, false)) {
  app.use("/internal/content", createContentControlRouter({ control: contentControl }));
}

async function handleThreadsWebhook({ native, event }) {
  await persistDurable("threads-comment", () => durable.recordSocialEvent(event));
  if (!legacy.safety.isEnabled()) {
    console.log("Bot disabled: Threads webhook acknowledged only");
    return { status: "ignored", reason: "BOT_DISABLED" };
  }
  if (!legacy.safety.isReady() || !legacy.humanLocks.isReady()) {
    console.error("Reply skipped", JSON.stringify({ platform: "threads", reason: "SAFETY_STORE_UNAVAILABLE" }));
    return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };
  }
  await legacy.handleComment(native);
  return { status: "ok" };
}

async function handleSecondaryWebhook({ platform, provider, event }) {
  if (platform === "youtube") {
    const runtime = secondaryCommunity.get(provider.accountKey);
    return runtime ? runtime.handleComment(event) : { status: "ignored", reason: "COMMUNITY_RUNTIME_MISSING" };
  }
  const persisted = await persistDurable(`${platform}-comment`, () => durable.recordSocialEvent(event));
  if (!persisted && postgresStore.isRequired()) {
    return { status: "ignored", reason: "DURABLE_STORE_UNAVAILABLE" };
  }
  const runtime = secondaryCommunity.get(provider.accountKey);
  if (!runtime) {
    console.error("Reply skipped", JSON.stringify({ platform, accountKey: provider.accountKey, reason: "COMMUNITY_RUNTIME_MISSING" }));
    return { status: "ignored", reason: "COMMUNITY_RUNTIME_MISSING" };
  }
  const result = await runtime.handleComment(event);
  if (result?.replyId || result?.status) {
    await persistDurable(`${platform}-reply`, () => durable.recordReply({
      accountKey: provider.accountKey,
      sourceCommentId: event?.sourceId,
      replyId: result?.replyId || null,
      status: result?.status || "UNKNOWN",
      text: result?.replyText || null,
      publishedAt: result?.replyId ? new Date() : null,
      metadata: { reason: result?.reason || null, code: result?.code || null, platform },
    }));
  }
  console.log("Community event processed", JSON.stringify({
    platform,
    accountKey: provider.accountKey,
    sourceId: event?.sourceId || null,
    status: result?.status || null,
    reason: result?.reason || null,
    code: result?.code || null,
    replyId: result?.replyId || null,
  }));
  return result;
}

const metaWebhookRouter = createMetaWebhookRouter({
  providerRegistry: legacy.socialContext.providers,
  handlers: {
    threads: handleThreadsWebhook,
    instagram: handleSecondaryWebhook,
    facebook: handleSecondaryWebhook,
  },
});

app.get("/", (_req, res) => {
  res.status(200).send("Astel Social Engine is running — Meta multi-platform v1");
});

app.get("/health", async (_req, res) => {
  let ambiguousPending = null;
  try {
    if (legacy.safety.isReady()) ambiguousPending = await legacy.safety.ambiguousCount();
  } catch (_) {}

  const redis = legacy.safety.health();
  const humanLock = legacy.humanLocks.health();
  const database = postgresStore.health();
  const secondary = Array.from(secondaryCommunity.values()).map(runtime => runtime.health());
  const secondaryOk = secondary.every(item =>
    !item.enabled || (item.redis?.connected && item.humanLock?.connected)
  );
  const publishing = publishEngine.health();
  const publishingOk = !publishing.enabled || publishing.repository?.connected;
  const analytics = analyticsEngine.health();
  const content = contentRuntime.health();
  const contentOk = !content.enabled || content.ready;
  const crew = hyperCrew.health();
  const crewOk = !crew.enabled || crew.ready;
  const control = contentControl.health();
  const controlOk = !control.enabled || control.ready;
  const databaseOk = !database.required || database.connected;
  const ok = (!legacy.policy.redisRequired || redis.connected) && humanLock.connected && secondaryOk && publishingOk && contentOk && crewOk && controlOk && databaseOk;

  res.status(ok ? 200 : 503).json({
    ok,
    version: "meta-v1",
    enabled: legacy.safety.isEnabled(),
    dryRun: legacy.safety.isDryRun(),
    redis,
    humanLock,
    database: { ...database, lastProjectionError: lastDurableProjectionError },
    ambiguousPending,
    policy: legacy.policy,
    limits: legacy.safety.limits,
    memory: { maxMessages: Number(MAX_MEMORY_MESSAGES), maxTokens: Number(MAX_MEMORY_TOKENS) },
    vision: {
      enabled: legacy.vision.isEnabled(),
      detail: legacy.vision.detail,
      maxImages: 1,
      moderation: "omni-moderation-latest",
      failClosedOnImageError: true,
      platforms: ["threads"],
    },
    social: legacy.socialContext.health(),
    community: {
      threads: {
        accountKey: legacy.threads.accountKey,
        platform: "threads",
        enabled: legacy.safety.isEnabled(),
        dryRun: legacy.safety.isDryRun(),
        redis,
        humanLock,
      },
      secondary,
    },
    publishing,
    analytics,
    content,
    hyperCrew: crew,
    contentControl: control,
    proactive: {
      enabled: proactiveConfig.enabled,
      mode: proactiveConfig.mode,
      account: proactiveConfig.account || null,
      dailyDraftLimit: proactiveConfig.dailyDraftLimit,
      dailyAiTokenLimit: proactiveConfig.dailyAiTokenLimit,
    },
  });
});

app.get("/webhook", (req, res) => {
  const verification = metaWebhookRouter.verify(req.query);
  if (verification.ok) return res.status(200).send(verification.challenge);
  return res.sendStatus(403);
});

app.post("/webhook", createMetaWebhookSignature(), async (req, res) => {
  if (postgresStore.isRequired() && !postgresStore.isReady()) return res.sendStatus(503);
  res.sendStatus(200);
  try {
    const result = await metaWebhookRouter.dispatch(req.body);
    console.log("Meta webhook routed", JSON.stringify(result));
  } catch (error) {
    console.error("Webhook processing error:", error?.message || String(error));
  }
});

async function start() {
  const databaseStart = await postgresStore.init();
  if (postgresStore.isReady()) await durable.syncAccounts(legacy.socialContext.accounts);

  if (legacy.threads.account?.enabled && legacy.threads.tokenManager?.init) await legacy.threads.tokenManager.init();
  await legacy.safety.init();
  await legacy.humanLocks.init();
  for (const runtime of secondaryCommunity.values()) await runtime.init();

  const contentStart = await contentRuntime.init();
  const crewStart = await hyperCrew.init();
  const controlStart = await contentControl.init();
  const publishStart = await publishEngine.start();
  const analyticsStart = await analyticsEngine.start();
  console.log("Content runtime startup", JSON.stringify(contentStart));
  console.log("Hyper Crew startup", JSON.stringify(crewStart));
  console.log("Content control startup", JSON.stringify(controlStart));
  console.log("Publish engine startup", JSON.stringify(publishStart));
  console.log("Analytics engine startup", JSON.stringify(analyticsStart));
  console.log("Durable database startup", JSON.stringify(databaseStart));

  app.listen(PORT, () => {
    console.log(`Astel Social Engine listening on port ${PORT}; model=${OPENAI_MODEL}; providers=${legacy.socialContext.providers.list().length}; threadsEnabled=${legacy.safety.isEnabled()}; threadsDryRun=${legacy.safety.isDryRun()}; secondary=${secondaryCommunity.size}; publishEnabled=${publishEngine.health().enabled}; publishDryRun=${publishEngine.health().dryRun}; analyticsEnabled=${analyticsEngine.health().enabled}; contentEnabled=${contentRuntime.health().enabled}; hyperCrewEnabled=${hyperCrew.health().enabled}; contentControlEnabled=${contentControl.health().enabled}; databaseConnected=${postgresStore.isReady()}`);
  });

  if (PROACTIVE_PERMISSION_PROBE === "true") {
    const result = await legacy.threadsDiscovery.searchPosts({ query: "business", searchType: "RECENT", limit: 1 });
    console.log("Threads keyword permission probe", JSON.stringify({
      status: result.status,
      reason: result.reason || null,
      httpStatus: result.httpStatus || null,
      apiErrorCode: result.apiErrorCode || null,
      postCount: Array.isArray(result.posts) ? result.posts.length : 0,
    }));
  }

  const proactiveStart = await legacy.proactiveRunner.start();
  console.log("Proactive copilot startup", JSON.stringify(proactiveStart));
}

if (require.main === module) {
  start().catch(error => {
    console.error("Fatal startup error:", error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  metaWebhookRouter,
  secondaryCommunity,
  postgresStore,
  durable,
  analyticsRepository,
  analyticsEngine,
  internalAnalyticsRouter,
  contentRuntime,
  hyperCrew,
  contentControlStore,
  contentControl,
  hotPublishRepository,
  publishRepository,
  publishEngine,
  handleThreadsWebhook,
  handleSecondaryWebhook,
};
