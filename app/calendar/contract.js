"use strict";
const crypto = require("node:crypto");
const net = require("node:net");
const TERMINAL = new Set(["SIMULATED", "PUBLISHED", "FAILED", "AMBIGUOUS_HOLD", "CANCELLED"]);
const choice = value => String(value?.name ?? value ?? "").trim();

function mediaUrl(value) {
  let u;
  try { u = new URL(String(value || "").trim()); } catch (_) { throw new Error("DIRECT_MEDIA_URL_REQUIRED"); }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443") ||
      net.isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") ||
      /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) ||
      /(^|\.)(drive\.google\.com|docs\.google\.com|dropbox\.com)$/.test(host)) {
    throw new Error("PUBLIC_DIRECT_HTTPS_MEDIA_REQUIRED");
  }
  if (u.href.length > 4096) throw new Error("MEDIA_URL_TOO_LONG");
  return u.href;
}

function parseRecord(record, { brand = "astel.us" } = {}) {
  const f = record?.fields || {};
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(record?.id || ""))) throw new Error("INVALID_RECORD_ID");
  const platform = choice(f.Platform).toLowerCase();
  const type = choice(f.Format).toLowerCase();
  if (!["threads", "instagram"].includes(platform)) throw new Error("PLATFORM_NOT_ALLOWED");
  if (platform === "threads" && type !== "text") throw new Error("THREADS_TEXT_ONLY");
  if (platform === "instagram" && !["image", "reel"].includes(type)) throw new Error("INSTAGRAM_IMAGE_OR_REEL_REQUIRED");
  const text = String(f.Caption || "").trim();
  if (type === "text" && !text) throw new Error("CAPTION_REQUIRED");
  // Conservative UTF-8 limit for Threads; Instagram captions are Unicode characters.
  if (platform === "threads" && Buffer.byteLength(text, "utf8") > 500) throw new Error("THREADS_TEXT_OVER_500_BYTES");
  if (platform === "instagram" && [...text].length > 2200) throw new Error("INSTAGRAM_CAPTION_OVER_2200_CHARACTERS");
  const mode = choice(f["Delivery Mode"]);
  if (!["Simulation", "Live"].includes(mode)) throw new Error("EXPLICIT_DELIVERY_MODE_REQUIRED");
  const raw = String(f["Scheduled At"] || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error("SCHEDULE_REQUIRES_ISO_DATE_WITH_TIMEZONE");
  }
  const time = new Date(raw);
  if (!Number.isFinite(time.getTime())) throw new Error("INVALID_SCHEDULE");
  const revision = Number(f.Revision || 1);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 100000) throw new Error("INVALID_REVISION");
  const content = { type, text };
  if (platform === "instagram") content.mediaUrl = mediaUrl(f["Media URL"]);
  const payload = { recordId: record.id, accountKey: `${brand}:${platform}`, content,
    scheduledAt: time.toISOString(), mode, revision };
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { id: `cal_${hash}`, hash, ...payload, platform, reviewer: choice(f.Reviewer),
    approval: choice(f.Approval), reviewHash: choice(f["Review Hash"]) };
}

function errorCode(error, fallback = "CALENDAR_OPERATION_FAILED") {
  const value = String(error?.message || error || "");
  // Never surface arbitrary transport errors (URLs can contain bearer/signed credentials).
  return /^[A-Z][A-Z0-9_:.-]{2,180}$/.test(value) ? value : fallback;
}
module.exports = { parseRecord, choice, mediaUrl, TERMINAL, errorCode };
