const base = require("./server-meta");
const legacy = require("./server");
const { createInstagramCommentPoller } = require("./app/polling/instagramCommentPoller");
const { createFacebookCommentPoller } = require("./app/polling/facebookCommentPoller");
const { createThreadsCommentPoller } = require("./app/polling/threadsCommentPoller");
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

// Publication scheduling is isolated from all existing comment auto-reply flags and stores.
const { createPublicationCalendar } = require("./app/calendar/runtime");
const publicationCalendar = createPublicationCalendar({ store: base.postgresStore, socialContext: legacy.socialContext });
base.app.get("/health/publication-calendar", (_req, res) => {
  const status = publicationCalendar.health();
  const ok = !status.enabled || (status.initialized && status.repository?.connected && !status.lastError);
  res.status(ok ? 200 : 503).json({ ok, calendar: status });
});


const instagramPollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "instagram")
  .map(provider => createInstagramCommentPoller({
    provider,
    handler: base.handleSecondaryWebhook,
    redisUrl: REDIS_URL,
    enabled: bool(INSTAGRAM_POLLING_ENABLED, false) && provider.account?.enabled !== false,
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
    enabled: bool(FACEBOOK_POLLING_ENABLED, false) && provider.account?.enabled !== false,
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
    enabled: bool(THREADS_POLLING_ENABLED, false) && provider.account?.enabled !== false,
    intervalMs: Number(THREADS_POLLING_INTERVAL_MS),
    postsLimit: Number(THREADS_POLLING_POSTS_LIMIT),
    repliesLimit: Number(THREADS_POLLING_REPLIES_LIMIT),
    fullScanEvery: Number(THREADS_POLLING_FULL_SCAN_EVERY),
  }));

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

  // Do not make an optional calendar outage shut down working comment auto-replies.
  publicationCalendar.start().then(result => console.log("Publication calendar startup", JSON.stringify(result)))
    .catch(() => console.error("Publication calendar startup failed"));

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
  publicationCalendar,
};
