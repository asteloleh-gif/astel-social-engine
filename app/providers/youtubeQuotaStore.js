// A project-wide ledger, shared by all accounts and modes. Splitting this key
// per channel/dry-run would undercount actual Google project quota usage.
const YOUTUBE_QUOTA_COSTS = Object.freeze({ read: 1, reply: 50, moderation: 50 });
const QUOTA_RESERVE_SCRIPT = `
  local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
  local replies = tonumber(redis.call('HGET', KEYS[1], 'replies') or '0')
  local cost = tonumber(ARGV[1])
  local budget = tonumber(ARGV[2])
  local operation = ARGV[3]
  local cap = tonumber(ARGV[4])
  if used + cost > budget then return {0, used, replies, 1} end
  if operation == 'reply' and replies >= cap then return {0, used, replies, 2} end
  redis.call('HINCRBY', KEYS[1], 'used', cost)
  redis.call('HINCRBY', KEYS[1], operation .. 'Units', cost)
  if operation == 'reply' then replies = redis.call('HINCRBY', KEYS[1], 'replies', 1) end
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
  return {1, used + cost, replies, 0}
`;

function configuredInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function youtubeQuotaDay(now) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const part = type => parts.find(value => value.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function createYouTubeQuotaStore({
  env = process.env, redisUrl = env.REDIS_URL, dailyBudget = env.YOUTUBE_DAILY_QUOTA_BUDGET,
  liveReplyDailyCap = env.YOUTUBE_LIVE_REPLY_DAILY_CAP,
  clientFactory = options => require("redis").createClient(options),
  clock = () => Date.now(),
} = {}) {
  const namespace = "astel:youtube:quota:v1";
  const budget = configuredInteger(dailyBudget, 9000);
  const replyCap = configuredInteger(liveReplyDailyCap, 20);
  let client = null;
  let connecting = null;
  let lastError = null;
  let lastCounters = null;
  const date = () => youtubeQuotaDay(clock());
  const isReady = () => Boolean(client?.isReady);

  async function init() {
    if (isReady()) return { ready: true };
    if (!redisUrl) { lastError = "QUOTA_STORE_UNAVAILABLE"; return { ready: false, reason: lastError }; }
    if (!connecting) connecting = (async () => {
      try {
        if (!client) {
          client = clientFactory({ url: redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false } });
          client.on?.("error", () => { lastError = "QUOTA_STORE_ERROR"; });
        }
        if (!client.isOpen) await client.connect();
        await client.ping();
        if (!isReady()) throw new Error("unavailable");
        lastError = null;
        return { ready: true };
      } catch (_) { lastError = "QUOTA_STORE_UNAVAILABLE"; return { ready: false, reason: lastError }; }
    })().finally(() => { connecting = null; });
    return connecting;
  }

  async function reserve(input = {}) {
    const operation = input.operation || "read";
    const expectedCost = YOUTUBE_QUOTA_COSTS[operation];
    const units = input.units ?? expectedCost;
    if (!Object.prototype.hasOwnProperty.call(YOUTUBE_QUOTA_COSTS, operation) || units !== expectedCost) {
      return { ok: false, status: "failed", reason: "INVALID_QUOTA_REQUEST" };
    }
    if (!isReady()) return { ok: false, status: "failed", reason: "QUOTA_STORE_UNAVAILABLE" };
    try {
      const day = date();
      const result = await client.eval(QUOTA_RESERVE_SCRIPT, {
        keys: [`${namespace}:${day}`],
        arguments: [String(units), String(budget), operation, String(replyCap), String(3 * 86400)],
      });
      if (!Array.isArray(result) || result.length !== 4 || result.some(value => !Number.isSafeInteger(Number(value)))) {
        throw new Error("invalid ledger result");
      }
      const [granted, used, replies, denial] = result.map(Number);
      if (![0, 1].includes(granted) || used < 0 || replies < 0 || ![0, 1, 2].includes(denial) || (granted === 1 && denial !== 0)) throw new Error("invalid ledger result");
      if (granted === 1 && (used < units || used > budget || (operation === "reply" && (replies < 1 || replies > replyCap)))) throw new Error("invalid ledger result");
      lastCounters = { date: day, used, replies, remaining: Math.max(0, budget - used) };
      lastError = granted ? null : denial === 2 ? "LIVE_REPLY_CAP" : "QUOTA_BUDGET_EXCEEDED";
      return { ok: granted === 1, status: granted ? "ok" : "failed", ...(granted ? {} : { reason: lastError }), units: granted ? units : 0, ...lastCounters };
    } catch (_) {
      lastError = "QUOTA_STORE_ERROR";
      return { ok: false, status: "failed", reason: lastError };
    }
  }

  async function snapshot() {
    if (!isReady()) return { status: "failed", reason: "QUOTA_STORE_UNAVAILABLE" };
    try {
      const day = date();
      const values = await client.hGetAll(`${namespace}:${day}`);
      const counters = {};
      for (const field of ["used", "replies", "readUnits", "replyUnits", "moderationUnits"]) {
        const value = Number(values?.[field] ?? 0);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid ledger");
        counters[field] = value;
      }
      lastCounters = { date: day, ...counters, remaining: Math.max(0, budget - counters.used) };
      return { status: "ok", ...lastCounters, dailyBudget: budget, liveReplyDailyCap: replyCap };
    } catch (_) { lastError = "QUOTA_STORE_ERROR"; return { status: "failed", reason: lastError }; }
  }

  function health() {
    return { connected: isReady(), configured: Boolean(redisUrl), namespace, dailyBudget: budget, liveReplyDailyCap: replyCap,
      quotaDate: date(), resetTimezone: "America/Los_Angeles", counters: lastCounters?.date === date() ? lastCounters : null, lastError };
  }
  async function close() {
    try { if (client?.isOpen) await client.quit(); } finally { client = null; }
  }
  return { init, isReady, reserve, snapshot, health, close };
}

module.exports = { createYouTubeQuotaStore, YOUTUBE_QUOTA_COSTS, youtubeQuotaDay, QUOTA_RESERVE_SCRIPT };
