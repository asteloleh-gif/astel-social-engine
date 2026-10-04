const { createClient } = require("redis");

function createHumanLockStore({ redisUrl = process.env.REDIS_URL, namespace = "astel:v91", ttlSeconds = 24 * 60 * 60, redactErrors = false } = {}) {
  let client = null;
  let ready = false;
  let lastError = null;
  const keySafe = v => encodeURIComponent(String(v || ""));
  const lockKey = branchKey => `${namespace}:branch:${keySafe(branchKey)}:human-lock`;

  async function init() {
    if (!redisUrl) throw new Error("REDIS_URL missing for human lock store");
    client = createClient({ url: redisUrl });
    client.on("error", err => { ready = false; lastError = redactErrors ? "REDIS_HUMAN_LOCK_ERROR" : (err?.message || String(err)); });
    client.on("ready", () => { ready = true; lastError = null; });
    client.on("end", () => { ready = false; });
    await client.connect();
    await client.ping();
    ready = true;
    console.log("Human lock store connected", JSON.stringify({ namespace, ttlSeconds }));
    return true;
  }

  function assertReady() { if (!client || !ready) throw new Error(`Human lock store unavailable${lastError ? `: ${lastError}` : ""}`); }
  async function lock(branchKey) { assertReady(); if (!branchKey) return false; await client.set(lockKey(branchKey), "1", { EX: ttlSeconds }); return true; }
  async function isLocked(branchKey) { assertReady(); if (!branchKey) return false; return (await client.exists(lockKey(branchKey))) === 1; }
  async function quit() { if (client?.isOpen) await client.quit(); ready = false; }

  return { init, quit, lock, isLocked, isReady: () => ready, health: () => ({ connected: ready, lastError, ttlSeconds }) };
}

module.exports = { createHumanLockStore };
