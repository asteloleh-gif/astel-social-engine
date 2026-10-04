const { loadSocialAccounts, publicAccountView } = require("../accounts/accountConfig");
const { createProviderRegistry } = require("../providers/providerRegistry");
const { createThreadsProvider } = require("../providers/threadsProvider");
const { createInstagramProvider } = require("../providers/instagramProvider");
const { createFacebookProvider } = require("../providers/facebookProvider");

const { ASAP_GTA6_CHANNEL_ID } = require("../accounts/youtubeTarget");
const { createYouTubeProvider } = require("../providers/youtubeProvider");

function createApplicationContext({ env = process.env, providerFactories = {} } = {}) {
  const accounts = loadSocialAccounts(env);
  const primaryAccount = accounts[0];
  const registry = createProviderRegistry();

  const factories = {
    threads: providerFactories.threads || createThreadsProvider,
    instagram: providerFactories.instagram || createInstagramProvider,
    facebook: providerFactories.facebook || createFacebookProvider,
    youtube: providerFactories.youtube || createYouTubeProvider,
  };

  let primaryProvider = null;
  for (const account of accounts) {
    const factory = factories[account.platform];
    if (!factory) throw new Error(`No provider factory for ${account.platform}`);
    const provider = registry.register(factory({ account, ...(account.platform === "youtube" ? { env, requiredChannelId: ASAP_GTA6_CHANNEL_ID } : {}) }));
    if (account.key === primaryAccount.key) primaryProvider = provider;
  }

  if (!primaryProvider) throw new Error(`Primary provider missing for ${primaryAccount.key}`);

  function health() {
    return {
      primaryAccount: publicAccountView(primaryAccount),
      accounts: accounts.map(publicAccountView),
      providers: registry.list().map(provider => provider.health()),
    };
  }

  return {
    accounts,
    primaryAccount,
    primaryProvider,
    providers: registry,
    health,
  };
}

module.exports = { createApplicationContext };
