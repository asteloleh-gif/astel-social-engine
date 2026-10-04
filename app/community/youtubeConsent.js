const FEATURE = "youtube_comment_reply";
// Gate 1–3 build. There is deliberately no env switch that enables publication.
const LIVE_TRANSPORT_ENABLED = false;
function evaluateYouTubeConsent({ mode = "DRAFT_ONLY", channelId, approval, now = Date.now(), dailyCap = 20 } = {}) {
  if (String(mode).toUpperCase() === "OFF") return { mode: "OFF", reason: "MODULE_OFF", approvalId: null };
  const draft = reason => ({ mode: "DRAFT_ONLY", reason, approvalId: null });
  if (!approval) return draft("CONSENT_MISSING");
  if (!approval.id || approval.status !== "APPROVED" || approval.feature !== FEATURE ||
      !channelId || approval.channelId !== channelId || approval.mode !== "LIVE_APPROVED" ||
      !approval.reviewer || !approval.source || !Number.isFinite(Date.parse(approval.timestamp)) ||
      !Number.isInteger(approval.maxRepliesPerDay) || approval.maxRepliesPerDay < 1 ||
      approval.maxRepliesPerDay > dailyCap || approval.scope !== "top_level_comments") return draft("CONSENT_INVALID");
  const starts = Date.parse(approval.startsAt), expires = Date.parse(approval.expiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(expires) || expires <= starts || now < starts || now >= expires) return draft("CONSENT_EXPIRED_OR_NOT_STARTED");
  return { mode: "DRAFT_ONLY", reason: "LIVE_TRANSPORT_DISABLED", approvalId: approval.id };
}
module.exports = { FEATURE, LIVE_TRANSPORT_ENABLED, evaluateYouTubeConsent };
