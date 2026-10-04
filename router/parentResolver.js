async function resolveParentForRouting(c, {
  safety,
  threads,
  ownerUsername,
  ownerUserId,
  lookupEnabled = true,
  graphRoutingEnabled = false,
  sanitizeErrors = false,
} = {}) {
  if (!safety || !threads) throw new Error("parent resolver requires safety and threads dependencies");

  const parentId = threads.getParentId(c);

  // v9.1.1a invariant: a successfully published bot reply ID is
  // authoritative owner relationship data and bypasses Meta lookup.
  if (parentId && await safety.isBotGeneratedId(parentId)) {
    const parent = {
      parentId,
      parentAuthorId: ownerUserId || null,
      parentAuthorUsername: ownerUsername || null,
      source: "redis-bot-id",
    };
    await recordGraphShadow(c, parent, { safety, threads, ownerUsername, ownerUserId, sanitizeErrors });
    return parent;
  }

  // v9.1.1c.1: for moderate reply webhooks, target_id is the owner media that
  // received the reply. This is authoritative relationship data from the
  // webhook envelope itself. It matters when the owner media is itself a reply:
  // root_post.id points at the upstream conversation root, while replied_to.id
  // points at Leo's reply post. Meta may reject direct lookup of that reply ID.
  const webhookTargetId = threads.getWebhookTargetId?.(c) || null;
  if (parentId && webhookTargetId && String(parentId) === String(webhookTargetId)) {
    const parent = {
      parentId,
      parentAuthorId: ownerUserId || null,
      parentAuthorUsername: ownerUsername || null,
      source: "webhook-target-owner",
    };
    await recordGraphShadow(c, parent, { safety, threads, ownerUsername, ownerUserId, sanitizeErrors });
    return parent;
  }

  // v9.1.1b is shadow-first by default. Graph routing must be explicitly
  // enabled later; until then Graph can be populated/observed without changing
  // production routing decisions.
  if (graphRoutingEnabled && parentId && typeof safety.getGraphNode === "function") {
    const node = await safety.getGraphNode(parentId);
    if (node) {
      const parent = {
        parentId,
        parentAuthorId: node.authorId || null,
        parentAuthorUsername: node.username || null,
        source: "conversation-graph",
      };
      await recordGraphShadow(c, parent, { safety, threads, ownerUsername, ownerUserId, sanitizeErrors });
      return parent;
    }
  }

  const parent = await threads.resolveParentAuthor(c, {
    ownerUsername,
    ownerUserId,
    lookupEnabled,
  });
  await recordGraphShadow(c, parent, { safety, threads, ownerUsername, ownerUserId, sanitizeErrors });
  return parent;
}

async function recordGraphShadow(c, parent, {
  safety,
  threads,
  ownerUsername,
  ownerUserId,
  sanitizeErrors = false,
}) {
  if (typeof safety.recordGraphNode !== "function") return;

  const commentId = threads.getCommentId?.(c) || c?.id || null;
  const rootId = threads.getRootPostId?.(c) || null;
  if (!commentId || !rootId) return;

  try {
    const authorId = threads.getAuthorId?.(c) || null;
    const username = threads.getAuthorUsername?.(c) || null;
    const text = threads.getCommentText?.(c) || null;
    const isOwner = safety.isSelfAuthored?.({ authorId, authorUsername: username }) || false;
    const node = await safety.recordGraphNode({
      commentId,
      parentId: parent?.parentId || threads.getParentId(c) || null,
      rootId,
      authorId,
      username,
      text,
      isOwner,
      isBotGenerated: false,
      parentAuthorId: parent?.parentAuthorId || null,
      parentAuthorUsername: parent?.parentAuthorUsername || null,
      ownerUserId,
      ownerUsername,
    });
    console.log("Conversation graph shadow", JSON.stringify({
      sourceCommentId: String(commentId),
      branchKey: node?.branchKey || null,
      relationshipStatus: node?.relationshipStatus || null,
      parentSource: parent?.source || null,
    }));
  } catch (e) {
    // Shadow mode must not break the already-working v9.1.1a router.
    console.error("Conversation graph shadow error", JSON.stringify({
      sourceCommentId: String(commentId),
      error: sanitizeErrors ? "GRAPH_SHADOW_ERROR" : (e?.message || String(e)),
    }));
  }
}

module.exports = { resolveParentForRouting };
