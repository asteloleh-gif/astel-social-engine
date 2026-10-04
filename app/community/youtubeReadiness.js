function youtubeReadiness({ providers = [], polling = [], community = [] } = {}) {
  const accounts = polling.map(poll => {
    const provider = providers.find(p => p.accountKey === poll.accountKey);
    const runtime = community.find(r => r.accountKey === poll.accountKey);
    const blockers = [];
    if (poll.enabled) {
      if (!provider?.identityVerified || provider.identity?.id !== provider.channelId) blockers.push("AUTH_CHANNEL_UNVERIFIED");
      if (!poll.initialized || !poll.primed || !poll.running || !poll.store?.connected) blockers.push("POLLING_NOT_READY");
      if (poll.lastError || poll.lastStats?.status === "failed") blockers.push("LAST_POLL_FAILED");
      if (!runtime?.durableReady) blockers.push("DURABLE_STORE_UNAVAILABLE");
      if (!runtime?.redis?.connected || !runtime?.humanLock?.connected) blockers.push("SAFETY_STORE_UNAVAILABLE");
    }
    return { accountKey: poll.accountKey, enabled: poll.enabled, ready: poll.enabled && blockers.length === 0,
      state: !poll.enabled ? "DISABLED" : blockers.length ? "BLOCKED" : "DRAFT_ONLY_READY", blockers };
  });
  return { ok: accounts.every(a => !a.enabled || a.ready), configured: providers.length > 0,
    mode: "DRAFT_ONLY", liveTransportEnabled: false, accounts, providers, polling, community };
}
module.exports = { youtubeReadiness };
