// Preserve the complete existing RU Meta/Threads runtime; add only Instagram polling.
const base = require("./server-meta");
const legacy = require("./server");
const { createInstagramCommentPoller } = require("./app/polling/instagramCommentPoller");
const bool = value => String(value || "").trim().toLowerCase() === "true";
const env = process.env;
const instagramPollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "instagram")
  .map(provider => createInstagramCommentPoller({
    provider, handler: base.handleSecondaryWebhook, redisUrl: env.REDIS_URL,
    enabled: bool(env.INSTAGRAM_POLLING_ENABLED) && provider.account?.enabled !== false,
    intervalMs: Number(env.INSTAGRAM_POLLING_INTERVAL_MS || 60000),
    mediaLimit: Number(env.INSTAGRAM_POLLING_MEDIA_LIMIT || 10),
    commentsLimit: Number(env.INSTAGRAM_POLLING_COMMENTS_LIMIT || 50),
    fullScanEvery: Number(env.INSTAGRAM_POLLING_FULL_SCAN_EVERY || 10),
  }));
base.app.get("/health/instagram-polling", (_req, res) => {
  const polling = instagramPollers.map(p => p.health());
  const ok = polling.every(p => !p.enabled || p.store?.connected);
  res.status(ok ? 200 : 503).json({ ok, polling });
});
async function start() {
  await base.start();
  const results = [];
  for (const poller of instagramPollers) results.push(await poller.init());
  console.log("Instagram polling startup", JSON.stringify(results));
}
if (require.main === module) start().catch(error => {
  console.error("Fatal runtime startup error:", error?.message || String(error));
  process.exit(1);
});
module.exports = { ...base, start, instagramPollers };
