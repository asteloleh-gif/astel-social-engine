const { createClient } = require("redis");
const { createThreadsPollingStore } = require("./threadsPollingStore");

// Reuse the established polling set/connection implementation, not reply safety.
// Hex encoding keeps YouTube's case-sensitive identifiers distinct despite the
// underlying store's lowercase key normalization.
const SEEN_SENTINEL = "__youtube_polling_baseline_v1__";
function encodedAccount(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("YOUTUBE_ACCOUNT_KEY_MISSING");
  return Buffer.from(value, "utf8").toString("hex");
}

function createYouTubePollingStore({
  redisUrl,
  namespace = "astel:youtube-poll:v1:draft",
  ttlSeconds = 1209600,
  clientFactory = createClient,
} = {}) {
  const ttl = Number.isSafeInteger(Number(ttlSeconds)) && Number(ttlSeconds) > 0
    ? Number(ttlSeconds) : 1209600;
  let client;
  const sets = createThreadsPollingStore({
    redisUrl,
    namespace,
    ttlSeconds: ttl,
    clientFactory(options) {
      client = clientFactory(options);
      return client;
    },
  });
  const metadataKey = accountKey => `${namespace}:${encodedAccount(accountKey)}:baseline`;
  function requireReady() {
    if (!client || !sets.health().connected) throw new Error("YOUTUBE_POLL_STORE_UNAVAILABLE");
  }

  async function getState(accountKey) {
    requireReady();
    const key = encodedAccount(accountKey);
    const [rawMetadata, seen, knownThreads] = await Promise.all([
      client.get(metadataKey(accountKey)), sets.getSeen(key), sets.getKnownPosts(key),
    ]);
    let metadata = null;
    try { metadata = rawMetadata ? JSON.parse(rawMetadata) : null; } catch (_) { /* Re-prime malformed state. */ }
    const seenStatePresent = seen.delete(SEEN_SENTINEL);
    return { metadata, seen, knownThreads, seenStatePresent };
  }

  async function markSeen(accountKey, ids = []) {
    requireReady();
    // Only commitPrime may create the baseline sentinel. If Redis expires or
    // evicts this set during a scan, normal writes must not accidentally certify
    // the recreated, incomplete set as a valid historical baseline.
    await sets.markSeen(encodedAccount(accountKey), ids);
  }

  async function markKnownThreads(accountKey, ids = []) {
    requireReady();
    await sets.markKnownPosts(encodedAccount(accountKey), ids);
  }

  async function commitPrime(accountKey, { ids = [], threadIds = [], metadata } = {}) {
    requireReady();
    if (!metadata || metadata.version !== 1 || !metadata.channelId || !Number.isFinite(metadata.baselineThrough)) {
      throw new Error("YOUTUBE_BASELINE_INVALID");
    }
    // Metadata is the commit marker. Partial Redis writes cannot certify a new
    // baseline; the caller must finish the full read before invoking this method.
    await client.set(metadataKey(accountKey), JSON.stringify({ version: 0, reason: "PRIME_IN_PROGRESS" }));
    await sets.markSeen(encodedAccount(accountKey), [SEEN_SENTINEL, ...ids]);
    await markKnownThreads(accountKey, threadIds);
    await client.set(metadataKey(accountKey), JSON.stringify(metadata)); // Deliberately durable, no EX.
  }

  async function updateHighWater(accountKey, metadata, timestamp) {
    requireReady();
    const highWaterAt = Math.max(Number(metadata.highWaterAt) || 0, Number(timestamp) || 0);
    await client.set(metadataKey(accountKey), JSON.stringify({ ...metadata, highWaterAt }));
  }

  function health() {
    const state = sets.health();
    return {
      connected: state.connected,
      namespace,
      ttlSeconds: ttl,
      durableBaseline: true,
      // Redis exceptions can contain connection credentials. Expose a code only.
      lastError: state.lastError ? "REDIS_POLLING_STORE_ERROR" : null,
    };
  }

  return { init: sets.init, getState, markSeen, markKnownThreads, commitPrime, updateHighWater, health, close: sets.close };
}

module.exports = { createYouTubePollingStore };
