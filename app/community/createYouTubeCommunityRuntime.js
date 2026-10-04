const crypto = require("crypto");
const { createCommunityRuntime } = require("./createCommunityRuntime");
const { classifyYouTubeCandidate } = require("./youtubeCandidateClassifier");
const { evaluateYouTubeConsent } = require("./youtubeConsent");

function draftId(accountKey, sourceId) {
  return `youtube-draft-${crypto.createHash("sha256").update(`${accountKey}:${sourceId}`).digest("hex")}`;
}
function validateDraft(value) {
  const text = String(value || "").trim();
  const emojis = text.match(/\p{Extended_Pictographic}/gu) || [];
  if (!text || text.length > 500 || emojis.length > 1 || /https?:\/\/|www\./i.test(text)) throw new Error("YOUTUBE_DRAFT_REVIEW_REQUIRED");
  if (/manually typed|написал (?:это )?вручную|i am not a bot|я не бот/iu.test(text)) throw new Error("YOUTUBE_DRAFT_IDENTITY_CLAIM");
  return text;
}

function createYouTubeCommunityRuntime({ provider, redisUrl, policy, durable, generateReply,
  getContext = async () => "", mode = "DRAFT_ONLY", approval = null, dailyCap = 20,
  clock = () => Date.now(), coreFactory = createCommunityRuntime } = {}) {
  if (provider?.platform !== "youtube" || !durable) throw new Error("YouTube runtime requires provider and durable repository");
  // Force drafts independently of caller config and provider implementation.
  const account = Object.freeze({ ...provider.account, dryRun: true });
  const isolatedProvider = { ...provider, account };
  const consent = () => evaluateYouTubeConsent({ mode, channelId: account.userId, approval, dailyCap, now: clock() });
  const metadataFor = (event, classification, extra = {}) => ({
    platform: "youtube", channelId: account.userId, accountKey: account.key,
    videoId: event.metadata?.videoId || event.rootId, videoTitle: event.metadata?.videoTitle || null,
    topLevelCommentId: event.metadata?.topLevelCommentId, authorChannelId: event.author?.id,
    authorDisplayName: event.author?.username, intent: classification.intent,
    content_seed: classification.contentSeed, mode: "draft", approvalId: consent().approvalId,
    quotaUnits: 0, capturedAt: event.timestamp || null, observedAt: new Date(clock()).toISOString(),
    // No implicit indefinite retention of YouTube API data.
    refreshOrDeleteBy: new Date(clock() + 30 * 86400000).toISOString(), ...extra,
  });
  async function save(event, classification, result, generated = {}) {
    await durable.saveDraft({
      draftId: result.status === "dry-run" ? draftId(account.key, event.sourceId)
        : draftId(account.key, event.sourceId).replace("youtube-draft-", "youtube-decision-"), accountKey: account.key,
      status: result.status === "dry-run" ? "NEEDS_REVIEW" : result.status.toUpperCase().replace(/-/g, "_"),
      source: "youtube_comment_reply",
      content: { commentText: event.text, replyCandidate: result.replyText || null, finalReply: null, replyId: null },
      metadata: metadataFor(event, classification, { status: result.status, reason: result.reason,
        model: generated.model || null, usage: generated.usage || null,
        reviewer: null, reviewedAt: null, consentReason: consent().reason }),
    });
  }
  const core = coreFactory({
    provider: isolatedProvider, redisUrl, sanitizeErrors: true,
    policy: { ...policy, normalReplyLimit: 1, closingEnabled: false, redisRequired: true },
    namespace: `astel:youtube:community:v1:${account.key}:${account.userId || "unpinned"}`,
    getContext, personaContextProvider: async () => "", // No Leo/Family memory or knowledge leakage.
    conversationKeyForEvent: event => event.metadata?.topLevelCommentId ? `youtube:thread:${event.metadata.topLevelCommentId}` : null,
    generateReply: async (...args) => {
      const generated = await generateReply(...args);
      return generated ? { ...generated, text: validateDraft(generated.text) } : null;
    },
    canPublish: async () => false,
    isKnownBotReply: replyId => durable.hasReplyId({ accountKey: account.key, replyId }),
    onDraft: async ({ event, replyText, generated }) => {
      await save(event, classifyYouTubeCandidate(event), { status: "dry-run", reason: "WOULD_REPLY", replyText }, generated);
    },
  });
  async function handleComment(event) {
    if (!account.enabled || consent().mode === "OFF") return { status: "ignored", reason: "MODULE_OFF" };
    if (!durable.isReady()) return { status: "ignored", reason: "DURABLE_STORE_UNAVAILABLE" };
    const identity = provider.health?.();
    if (!identity?.identityVerified || identity.identity?.id !== account.userId) return { status: "ignored", reason: "AUTH_CHANNEL_UNVERIFIED" };
    if (event?.platform !== "youtube" || event.accountKey !== account.key ||
        event.metadata?.channelId !== account.userId || event.metadata?.contextComplete !== true ||
        !event.metadata?.topLevelCommentId || !event.author?.id || !event.sourceId || !event.rootId) {
      return { status: "ignored", reason: "YOUTUBE_CONTEXT_UNVERIFIED" };
    }
    try {
      await durable.recordSocialEvent(event);
      const classification = classifyYouTubeCandidate(event);
      // Let the shared engine apply its creator/self guard and human-lock marker handling.
      if (event.author.id === account.userId) return await core.handleComment(event);
      if (classification.action !== "DRAFT") {
        const result = { status: classification.action === "SKIP" ? "ignored" : "human-review", reason: classification.reason,
          intent: classification.intent, contentSeed: classification.contentSeed };
        await save(event, classification, result);
        return result;
      }
      const raw = await core.handleComment(event);
      const { error: _privateError, ...result } = raw;
      // Drafts are persisted by the hook before shared Redis dedupe is committed.
      if (result.status !== "dry-run" && result.reason !== "DUPLICATE") await save(event, classification, result);
      return { ...result, intent: classification.intent, contentSeed: classification.contentSeed, mode: "DRAFT_ONLY" };
    } catch (_) { return { status: "ignored", reason: "DURABLE_OR_DRAFT_PREPARATION_FAILED" }; }
  }
  return { ...core, handleComment,
    init: async () => { try { return await core.init(); } catch (_) { throw new Error("YOUTUBE_SAFETY_INIT_FAILED"); } },
    health: () => ({ ...core.health(),
    redis: { ...core.health().redis, lastError: core.health().redis?.lastError ? "REDIS_SAFETY_ERROR" : null },
    humanLock: { ...core.health().humanLock, lastError: core.health().humanLock?.lastError ? "REDIS_HUMAN_LOCK_ERROR" : null },
    mode: consent().mode,
    liveTransportEnabled: false, consentReason: consent().reason, durableReady: durable.isReady(),
    channelId: account.userId, provider: provider.health(), perThreadLimit: 1 }) };
}
module.exports = { createYouTubeCommunityRuntime, draftId, validateDraft };
