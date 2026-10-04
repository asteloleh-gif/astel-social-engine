const base = require("./server-meta");
const legacy = require("./server");
const { createInstagramCommentPoller } = require("./app/polling/instagramCommentPoller");
const { createFacebookCommentPoller } = require("./app/polling/facebookCommentPoller");
const { createThreadsCommentPoller } = require("./app/polling/threadsCommentPoller");
const { createYouTubeCommentPoller } = require("./app/polling/youtubeCommentPoller");
const { youtubeReadiness } = require("./app/community/youtubeReadiness");
const { createPublicLegalRouter } = require("./app/legal/publicLegalRoutes");

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

const {
  REDIS_URL,
  INSTAGRAM_POLLING_ENABLED = "false",
  INSTAGRAM_POLLING_INTERVAL_MS = "60000",
  INSTAGRAM_POLLING_MEDIA_LIMIT = "10",
  INSTAGRAM_POLLING_COMMENTS_LIMIT = "50",
  INSTAGRAM_POLLING_FULL_SCAN_EVERY = "10",
  FACEBOOK_POLLING_ENABLED = "false",
  FACEBOOK_POLLING_INTERVAL_MS = "60000",
  FACEBOOK_POLLING_POSTS_LIMIT = "10",
  FACEBOOK_POLLING_COMMENTS_LIMIT = "50",
  FACEBOOK_POLLING_FULL_SCAN_EVERY = "10",
  THREADS_POLLING_ENABLED = "false",
  THREADS_POLLING_INTERVAL_MS = "60000",
  THREADS_POLLING_POSTS_LIMIT = "10",
  THREADS_POLLING_REPLIES_LIMIT = "50",
  THREADS_POLLING_FULL_SCAN_EVERY = "10",
} = process.env;

base.app.use(createPublicLegalRouter());

const instagramPollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "instagram")
  .map(provider => createInstagramCommentPoller({
    provider,
    handler: base.handleSecondaryWebhook,
    redisUrl: REDIS_URL,
    enabled: bool(INSTAGRAM_POLLING_ENABLED, false),
    intervalMs: Number(INSTAGRAM_POLLING_INTERVAL_MS),
    mediaLimit: Number(INSTAGRAM_POLLING_MEDIA_LIMIT),
    commentsLimit: Number(INSTAGRAM_POLLING_COMMENTS_LIMIT),
    fullScanEvery: Number(INSTAGRAM_POLLING_FULL_SCAN_EVERY),
  }));

const facebookPollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "facebook")
  .map(provider => createFacebookCommentPoller({
    provider,
    handler: base.handleSecondaryWebhook,
    redisUrl: REDIS_URL,
    enabled: bool(FACEBOOK_POLLING_ENABLED, false),
    intervalMs: Number(FACEBOOK_POLLING_INTERVAL_MS),
    postsLimit: Number(FACEBOOK_POLLING_POSTS_LIMIT),
    commentsLimit: Number(FACEBOOK_POLLING_COMMENTS_LIMIT),
    fullScanEvery: Number(FACEBOOK_POLLING_FULL_SCAN_EVERY),
  }));

const threadsPollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "threads")
  .map(provider => createThreadsCommentPoller({
    provider,
    handler: base.handleThreadsWebhook,
    redisUrl: REDIS_URL,
    enabled: bool(THREADS_POLLING_ENABLED, false),
    intervalMs: Number(THREADS_POLLING_INTERVAL_MS),
    postsLimit: Number(THREADS_POLLING_POSTS_LIMIT),
    repliesLimit: Number(THREADS_POLLING_REPLIES_LIMIT),
    fullScanEvery: Number(THREADS_POLLING_FULL_SCAN_EVERY),
  }));

const youtubePollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "youtube")
  .map(provider => createYouTubeCommentPoller({
    provider, handler: base.handleSecondaryWebhook, redisUrl: REDIS_URL,
    enabled: provider.account.enabled && bool(process.env.YOUTUBE_POLLING_ENABLED, false),
    intervalMs: Number(process.env.YOUTUBE_POLLING_INTERVAL_MS || 60000),
    maxResults: Number(process.env.YOUTUBE_POLLING_MAX_RESULTS || 100),
    fullScanEvery: Number(process.env.YOUTUBE_FULL_SCAN_EVERY || 10),
    mode: "DRAFT_ONLY",
  }));

base.app.get("/health/youtube-polling", (_req, res) => {
  const polling = youtubePollers.map(poller => poller.health());
  const providers = legacy.socialContext.providers.list()
    .filter(provider => provider.platform === "youtube").map(provider => provider.health());
  const community = Array.from(base.secondaryCommunity.values())
    .filter(runtime => runtime.provider.platform === "youtube").map(runtime => runtime.health());
  const readiness = youtubeReadiness({ providers, polling, community });
  res.status(readiness.ok ? 200 : 503).json(readiness);
});

base.app.get("/health/instagram-polling", (_req, res) => {
  const polling = instagramPollers.map(poller => poller.health());
  const ok = polling.every(item => !item.enabled || item.store?.connected);
  res.status(ok ? 200 : 503).json({ ok, polling });
});

base.app.get("/health/facebook-polling", (_req, res) => {
  const polling = facebookPollers.map(poller => poller.health());
  const ok = polling.every(item => !item.enabled || item.store?.connected);
  res.status(ok ? 200 : 503).json({ ok, polling });
});

base.app.get("/health/threads-polling", (_req, res) => {
  const polling = threadsPollers.map(poller => poller.health());
  const ok = polling.every(item => !item.enabled || item.store?.connected);
  res.status(ok ? 200 : 503).json({ ok, polling });
});

async function start() {
  await base.start();

  const instagramPollingStart = [];
  for (const poller of instagramPollers) instagramPollingStart.push(await poller.init());
  console.log("Instagram polling startup", JSON.stringify(instagramPollingStart));

  const facebookPollingStart = [];
  for (const poller of facebookPollers) facebookPollingStart.push(await poller.init());
  console.log("Facebook polling startup", JSON.stringify(facebookPollingStart));

  const threadsPollingStart = [];
  for (const poller of threadsPollers) threadsPollingStart.push(await poller.init());
  console.log("Threads polling startup", JSON.stringify(threadsPollingStart));

  const youtubePollingStart = [];
  for (const poller of youtubePollers) youtubePollingStart.push(await poller.init());
  console.log("YouTube polling startup", JSON.stringify(youtubePollingStart));
}

if (require.main === module) {
  start().catch(error => {
    console.error("Fatal runtime startup error:", error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  ...base,
  start,
  instagramPollers,
  facebookPollers,
  threadsPollers,
  youtubePollers,
};
