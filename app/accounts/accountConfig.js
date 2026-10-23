const SUPPORTED_PLATFORMS = Object.freeze(["threads", "instagram", "facebook"]);

function normalize(value) {
  return String(value || "").trim();
}

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function normalizePlatform(value) {
  const platform = normalize(value).toLowerCase();
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported social platform: ${platform || "missing"}`);
  }
  return platform;
}

function createAccountConfig(input = {}) {
  const platform = normalizePlatform(input.platform || "threads");
  const username = normalize(input.username).replace(/^@/, "");
  const brand = normalize(input.brand || username || "default").toLowerCase();
  const key = normalize(input.key || `${brand}:${platform}`).toLowerCase();

  if (!key) throw new Error("Social account key is required");
  if (!username) throw new Error(`Social account username is required for ${key}`);

  return Object.freeze({
    key,
    brand,
    platform,
    language: normalize(input.language || "auto").toLowerCase(),
    userId: normalize(input.userId) || null,
    username,
    accessToken: normalize(input.accessToken) || null,
    verifyToken: normalize(input.verifyToken) || null,
    ...(input.authMode ? { authMode: normalize(input.authMode).toLowerCase() } : {}),
    enabled: input.enabled !== false,
    dryRun: input.dryRun !== false,
  });
}

function loadPrimaryAccount(env = process.env) {
  return createAccountConfig({
    key: env.SOCIAL_ACCOUNT_KEY || undefined,
    brand: env.SOCIAL_BRAND || env.THREADS_USERNAME || "leoakastel",
    platform: "threads",
    language: env.SOCIAL_LANGUAGE || env.PROACTIVE_ACCOUNT || "auto",
    userId: env.THREADS_USER_ID,
    username: env.THREADS_USERNAME || "leoakastel",
    accessToken: env.THREADS_ACCESS_TOKEN || env.THREDS_ACCESS_TOKEN,
    verifyToken: env.THREADS_VERIFY_TOKEN,
    enabled: bool(env.BOT_ENABLED, false),
    dryRun: bool(env.BOT_DRY_RUN, true),
  });
}

function optionalPlatformAccount(env, platform) {
  const prefix = platform.toUpperCase();
  const hasAnyConfig = [
    `${prefix}_USER_ID`,
    `${prefix}_USERNAME`,
    `${prefix}_ACCESS_TOKEN`,
    `${prefix}_VERIFY_TOKEN`,
  ].some(name => normalize(env[name]));
  if (!hasAnyConfig) return null;

  const fallbackBrand = env.SOCIAL_BRAND || env.THREADS_USERNAME || "leoakastel";
  const username = env[`${prefix}_USERNAME`] || env[`${prefix}_PAGE_NAME`] || fallbackBrand;
  return createAccountConfig({
    key: env[`${prefix}_ACCOUNT_KEY`] || undefined,
    brand: env[`${prefix}_BRAND`] || fallbackBrand,
    platform,
    language: env[`${prefix}_LANGUAGE`] || env.SOCIAL_LANGUAGE || "auto",
    authMode: env[`${prefix}_AUTH_MODE`],
    userId: env[`${prefix}_USER_ID`],
    username,
    accessToken: env[`${prefix}_ACCESS_TOKEN`],
    verifyToken: env[`${prefix}_VERIFY_TOKEN`] || (bool(env.SOCIAL_REQUIRE_BRAND_ISOLATION) ? null : env.THREADS_VERIFY_TOKEN),
    enabled: bool(env[`${prefix}_ENABLED`], false),
    dryRun: bool(env[`${prefix}_DRY_RUN`], true),
  });
}

function loadSocialAccounts(env = process.env) {
  const accounts = [loadPrimaryAccount(env)];
  for (const platform of ["instagram", "facebook"]) {
    const account = optionalPlatformAccount(env, platform);
    if (account) accounts.push(account);
  }
  if (bool(env.SOCIAL_REQUIRE_BRAND_ISOLATION)) {
    const brand = normalize(env.SOCIAL_BRAND).toLowerCase();
    if (!brand || accounts.some(account => account.brand !== brand)) throw new Error("SOCIAL_BRAND_ISOLATION_REQUIRED");
  }
  return Object.freeze(accounts);
}

function publicAccountView(account) {
  if (!account) return null;
  return {
    key: account.key,
    brand: account.brand,
    platform: account.platform,
    language: account.language,
    userId: account.userId,
    username: account.username,
    enabled: account.enabled,
    dryRun: account.dryRun,
  };
}

module.exports = {
  SUPPORTED_PLATFORMS,
  createAccountConfig,
  loadPrimaryAccount,
  loadSocialAccounts,
  publicAccountView,
};
