const { createSafetyPipeline } = require("../../safety/pipeline");
const { createHumanLockStore } = require("../../safety/humanLockStore");
const { isHumanLockMarker } = require("../../policy/replyBehavior");
const { routeComment } = require("../../router/conversationRouter");
const { resolveParentForRouting } = require("../../router/parentResolver");
const { GRAPH_STATUS } = require("../../graph/conversationGraph");
const { createPersonaMemoryContextProvider } = require("./personaMemoryContext");

function createCommunityRuntime({
  provider,
  redisUrl,
  policy,
  getContext,
  generateReply,
  logInteraction,
  canPublish = async () => true,
  isKnownBotReply = async () => false,
  recordConfirmedBotReply = async () => false,
  maxMemoryMessages = 8,
  maxMemoryTokens = 1000,
  namespace,
  personaContextProvider,
  conversationKeyForEvent,
  onDraft,
  sanitizeErrors = false,
} = {}) {
  if (!provider?.account) throw new Error("Community runtime requires provider account");
  if (!policy) throw new Error("Community runtime requires policy");
  if (typeof getContext !== "function" || typeof generateReply !== "function") {
    throw new Error("Community runtime requires AI dependencies");
  }

  const account = provider.account;
  const ns = namespace || `astel:v91:${account.key}`;
  const dryRunMode = String(account.dryRun).toLowerCase() === "true";
  const safetyNamespace = dryRunMode ? `${ns}:dryrun` : ns;
  const safety = createSafetyPipeline({
    threadsUserId: account.userId,
    selfUserId: account.userId,
    selfUsername: account.username,
    botEnabled: String(account.enabled),
    botDryRun: String(account.dryRun),
    redisUrl,
    policy,
    namespace: safetyNamespace,
    redactErrors: sanitizeErrors,
  });
  const humanLocks = createHumanLockStore({
    redisUrl,
    namespace: safetyNamespace,
    redactErrors: sanitizeErrors,
    ttlSeconds: policy.conversationResetHours * 60 * 60,
  });
  const getPersonaContext = personaContextProvider || createPersonaMemoryContextProvider({ env: process.env });
  // Immediate in-process quarantine closes the gap between a confirmed external
  // mutation and Redis/durable bookkeeping. Durable/Redis markers cover restarts.
  const confirmedBotReplyIds = new Set();

  async function init() {
    await safety.init();
    await humanLocks.init();
    return true;
  }

  async function quit() {
    await Promise.allSettled([safety.quit?.(), humanLocks.quit?.()]);
  }

  async function handleComment(c) {
    if (!safety.isEnabled()) return { status: "ignored", reason: "BOT_DISABLED" };
    if (provider.health?.().configured === false) return { status: "ignored", reason: "PROVIDER_NOT_CONFIGURED" };
    if (!safety.isReady() || !humanLocks.isReady()) return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };

    const commentId = provider.getCommentId(c);
    const author = provider.getAuthorUsername(c);
    const authorId = provider.getAuthorId(c);
    const rootId = provider.getRootPostId(c);
    let text = provider.getCommentText(c) || "";
    const authorlessFacebook = provider.platform === "facebook" && !author && !authorId;
    if (!commentId || !rootId || (!author && !authorId && !authorlessFacebook)) {
      return { status: "ignored", reason: "INVALID_PAYLOAD" };
    }
    // Only Page-owned post polling has a trusted root when Meta omits `from`.
    // A webhook or arbitrary event without an author cannot establish that fact.
    if (authorlessFacebook && (
      c?.platform !== "facebook" || c?.accountKey !== account.key ||
      c?.metadata?.ingress !== "polling" ||
      String(c?.metadata?.targetPageId || "") !== String(account.userId || "")
    )) return { status: "ignored", reason: "AUTHORLESS_UNTRUSTED" };

    if (confirmedBotReplyIds.has(String(commentId))) {
      return { status: "ignored", reason: "BOT_GENERATED_OBJECT" };
    }
    try {
      if (await isKnownBotReply(String(commentId))) {
        confirmedBotReplyIds.add(String(commentId));
        return { status: "ignored", reason: "BOT_GENERATED_OBJECT" };
      }
    } catch (_) {
      // Durable lookup is defense-in-depth. Required durable-store failures are
      // already rejected by the outer handler; Redis safety remains authoritative.
    }

    const selfAuthored = safety.isSelfAuthored({ authorId, authorUsername: author });
    if (selfAuthored) {
      if (isHumanLockMarker(text)) {
        try {
          const parentId = provider.getParentId(c);
          const parentNode = parentId ? await safety.getGraphNode(parentId) : null;
          const branchKey = parentNode?.branchKey || null;
          if (!branchKey) return { status: "ignored", reason: "HUMAN_LOCK_TARGET_UNRESOLVED" };
          await humanLocks.lock(branchKey);
          return { status: "ok", reason: "HUMAN_LOCKED" };
        } catch (_) {
          return { status: "ignored", reason: "HUMAN_LOCK_STORE_UNAVAILABLE" };
        }
      }
      return { status: "ignored", reason: "SELF_COMMENT" };
    }

    try {
      if (await safety.isBotGeneratedId(commentId)) return { status: "ignored", reason: "BOT_GENERATED_OBJECT" };
      const existing = await safety.getSourceStatus(commentId);
      if (existing) return { status: "ignored", reason: "DUPLICATE" };
      if (authorlessFacebook) {
        const knownNode = await safety.getGraphNode(commentId);
        if (knownNode?.isBotGenerated) return { status: "ignored", reason: "BOT_GENERATED_OBJECT" };
        if (knownNode?.isOwner) return { status: "ignored", reason: "SELF_COMMENT" };
      }
    } catch (_) {
      return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };
    }

    let parent;
    try {
      parent = await resolveParentForRouting(c, {
        safety,
        threads: provider,
        ownerUsername: account.username,
        ownerUserId: account.userId,
        lookupEnabled: policy.parentLookupEnabled,
        sanitizeErrors,
      });
    } catch (_) {
      return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };
    }

    if (!authorlessFacebook) {
      const route = routeComment({
        authorId,
        authorUsername: author,
        ownerUserId: account.userId,
        ownerUsername: account.username,
        rootId,
        parentId: parent.parentId,
        parentAuthorId: parent.parentAuthorId,
        parentAuthorUsername: parent.parentAuthorUsername,
        text,
      });
      if (!route.allow) return { status: "ignored", reason: route.reason };
    }

    let graphNode;
    try { graphNode = await safety.getGraphNode(commentId); }
    catch (_) { return { status: "ignored", reason: "GRAPH_UNAVAILABLE" }; }
    if (!graphNode || graphNode.relationshipStatus !== GRAPH_STATUS.RESOLVED || !graphNode.branchKey) {
      return { status: "ignored", reason: authorlessFacebook ? "AUTHORLESS_UNTRUSTED" : "PENDING_RELATIONSHIP" };
    }

    const branchKey = graphNode.branchKey;
    if (authorlessFacebook) {
      const directRoot = parent.parentId && String(parent.parentId) === String(rootId);
      if (!directRoot) {
        let parentNode;
        try { parentNode = parent.parentId ? await safety.getGraphNode(parent.parentId) : null; }
        catch (_) { return { status: "ignored", reason: "GRAPH_UNAVAILABLE" }; }
        if (!parentNode || parentNode.relationshipStatus !== GRAPH_STATUS.RESOLVED ||
            parentNode.branchKey !== branchKey || String(parentNode.rootId) !== String(rootId)) {
          return { status: "ignored", reason: "AUTHORLESS_UNTRUSTED" };
        }
      }
    }
    try {
      if (await humanLocks.isLocked(branchKey)) return { status: "ignored", reason: "HUMAN_LOCKED" };
    } catch (_) { return { status: "ignored", reason: "HUMAN_LOCK_STORE_UNAVAILABLE" }; }

    // This is a conversation key, never a synthetic Facebook person identity.
    const userKey = authorlessFacebook ? `facebook:branch:${branchKey}` : safety.getUserKey({ authorId, authorUsername: author });
    const conversationKey = conversationKeyForEvent
      ? conversationKeyForEvent(c, { userKey, rootId })
      : safety.getConversationKey({ userKey, rootId });
    if (!conversationKey) return { status: "ignored", reason: "INVALID_CONVERSATION" };

    let reservation;
    try { reservation = await safety.reserve({ commentId, conversationKey }); }
    catch (_) { return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" }; }
    if (!reservation.allowed) return { status: "ignored", reason: reservation.reason };

    const leaseToken = reservation.reservationId;
    let leaseHeld = false;
    try { leaseHeld = await safety.acquireBranchLease(branchKey, leaseToken); }
    catch (_) {
      try { await safety.rollback(reservation); } catch (_) {}
      return { status: "ignored", reason: "BRANCH_LEASE_ERROR" };
    }
    if (!leaseHeld) {
      try { await safety.rollback(reservation); } catch (_) {}
      return { status: "ignored", reason: "BRANCH_BUSY" };
    }

    const replyNumber = reservation.replyNumber;
    const closeConversation = policy.closingEnabled && replyNumber === policy.closingAtReply;
    let replyText = null;
    let mutationMayHaveCommitted = false;
    try {
      if (await humanLocks.isLocked(branchKey)) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "HUMAN_LOCKED" };
      }

      if (!String(text).trim()) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "EMPTY_COMMENT_NO_SUPPORTED_MEDIA" };
      }

      const memory = await safety.getBranchMemory(commentId, {
        maxMessages: Number(maxMemoryMessages),
        maxTokens: Number(maxMemoryTokens),
      });
      if (memory.reason !== "OK") throw new Error(`MEMORY_${memory.reason}`);

      const [baseContext, personaContext] = await Promise.all([
        getContext(text, { platform: provider.platform, accountKey: account.key }),
        getPersonaContext(text),
      ]);
      const context = [baseContext, personaContext].filter(Boolean).join("\n\n");
      const generated = await generateReply(text, context, {
        closeConversation,
        memory: memory.messages,
        media: null,
        platform: provider.platform,
        trace: {
          traceId: reservation.reservationId,
          sourceCommentId: String(commentId),
          conversationKey,
          branchKey,
          accountKey: account.key,
          platform: provider.platform,
          hasImage: false,
        },
      });
      replyText = generated?.text || null;
      if (!replyText) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "AI_EMPTY_OR_FAILED" };
      }

      if (safety.isDryRun()) {
        // Keep dry-run idempotency/dedupe, but its isolated Redis namespace means
        // simulated successes can never consume the live reply/global budget.
        // Optional durable draft projection must succeed before consuming dedupe.
        if (onDraft) await onDraft({ event: c, replyText, generated, reservation });
        const committed = await safety.commitSuccess(reservation, null, null);
        if (onDraft && !committed) throw new Error("DRAFT_STATE_COMMIT_REJECTED");
        return onDraft ? { status: "dry-run", reason: "WOULD_REPLY", replyText,
          model: generated?.model || null, usage: generated?.usage || null }
          : { status: "dry-run", reason: "WOULD_REPLY" };
      }

      if (!(await safety.verifyBranchLease(branchKey, leaseToken))) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "BRANCH_LEASE_LOST" };
      }
      if (await humanLocks.isLocked(branchKey)) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "HUMAN_LOCKED" };
      }

      if (!(await canPublish())) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "DURABLE_STORE_UNAVAILABLE" };
      }
      let result;
      try {
        mutationMayHaveCommitted = true;
        result = await provider.reply(commentId, replyText);
      }
      catch (_) {
        try { await safety.markAmbiguous(reservation); } catch (_) {}
        return { status: "ambiguous", reason: "UNEXPECTED_PUBLISH_EXCEPTION" };
      }

      if (result.status === "published") {
        const publishedReplyId = result.id ? String(result.id) : null;
        if (!publishedReplyId) {
          try { await safety.markAmbiguous(reservation); } catch (_) {}
          return { status: "ambiguous", reason: "PUBLISHED_REPLY_ID_MISSING", replyText };
        }

        // Meta has confirmed the mutation. Quarantine the reply ID before normal
        // accounting so an authorless Facebook poll can never treat our reply as
        // an external comment merely because commitSuccess later fails.
        confirmedBotReplyIds.add(publishedReplyId);
        try { await safety.markBotGeneratedId(publishedReplyId); } catch (_) {}
        try {
          await recordConfirmedBotReply({
            accountKey: account.key,
            platform: provider.platform,
            sourceCommentId: String(commentId),
            replyId: publishedReplyId,
            replyText,
          });
        } catch (_) {}

        let committed = false;
        try {
          committed = await safety.commitSuccess(reservation, publishedReplyId, replyText);
        } catch (_) {
          try { await safety.markAmbiguous(reservation); } catch (_) {}
          return {
            status: "ambiguous",
            reason: "PUBLISH_STATE_COMMIT_FAILED",
            replyId: publishedReplyId,
            replyText,
          };
        }
        if (!committed) {
          try { await safety.markAmbiguous(reservation); } catch (_) {}
          return {
            status: "ambiguous",
            reason: "PUBLISH_STATE_COMMIT_REJECTED",
            replyId: publishedReplyId,
            replyText,
          };
        }
        if (typeof logInteraction === "function") {
          await logInteraction({
            platform: provider.platform,
            accountKey: account.key,
            commentId,
            author: author || authorId || "unknown",
            commentText: text,
            replyText,
          });
        }
        return { status: "published", replyId: result.id, replyText };
      }

      if (result.status === "ambiguous") {
        try { await safety.markAmbiguous(reservation); } catch (_) {}
        return { status: "ambiguous", reason: "AMBIGUOUS_PUBLISH" };
      }

      mutationMayHaveCommitted = false;
      await safety.rollback(reservation);
      return {
        status: "ignored",
        reason: result?.reason || "DEFINITIVE_PUBLISH_FAILURE",
        code: result?.code || null,
      };
    } catch (error) {
      if (mutationMayHaveCommitted) {
        try { await safety.markAmbiguous(reservation); } catch (_) {}
        return { status: "ambiguous", reason: "PUBLISH_STATE_OUTCOME_UNKNOWN" };
      }
      try { await safety.rollback(reservation); } catch (_) {}
      return { status: "ignored", reason: "COMMENT_PREPARATION_ERROR", error: sanitizeErrors ? "COMMENT_PREPARATION_FAILED" : (error?.message || String(error)) };
    } finally {
      try { await safety.releaseBranchLease(branchKey, leaseToken); } catch (_) {}
    }
  }

  function health() {
    return {
      accountKey: account.key,
      platform: provider.platform,
      configured: provider.health?.().configured !== false,
      enabled: safety.isEnabled(),
      dryRun: safety.isDryRun(),
      redis: safety.health(),
      humanLock: humanLocks.health(),
      limits: safety.limits,
    };
  }

  return { account, provider, safety, humanLocks, init, quit, handleComment, health };
}

module.exports = { createCommunityRuntime };
