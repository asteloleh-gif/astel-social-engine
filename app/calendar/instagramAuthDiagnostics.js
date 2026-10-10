"use strict";
const fetch = require('node-fetch');

const RELEVANT_PERMISSIONS = new Set([
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments',
  'pages_read_engagement', 'pages_show_list', 'business_management',
  'ads_read', 'ads_management',
]);

// Diagnostics must never return a raw Graph response or transport exception.
function safeGraphError(result, secrets = []) {
  const raw = result?.data?.error || {};
  let message = typeof raw.message === 'string' ? raw.message : '';
  for (const secret of secrets.filter(x => typeof x === 'string' && x.length)) {
    for (const value of new Set([secret, encodeURIComponent(secret)])) {
      message = message.split(value).join('[REDACTED]');
    }
  }
  message = message
    .replace(/(?:https?:\/\/)[^\s"'<>]+/gi, '[URL_REDACTED]')
    .replace(/((?:access_token|input_token|app_secret|client_secret|appsecret_proof)\s*[=:]\s*)[^\s&,;"']+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s,"']+/gi, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_+\/=.-]{60,}/g, '[OPAQUE_REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const namedPermissions = [...RELEVANT_PERMISSIONS].filter(p =>
    new RegExp('\\b' + p + '\\b').test(message));
  return {
    httpStatus: number(result?.http), code: number(raw.code),
    subcode: number(raw.error_subcode),
    message: result?.network ? 'NETWORK_ERROR' : (message || null),
    namedPermissions,
  };
}

// Read-only, startup-only investigation. Do not select/change a credential here.
// Both candidates are already configured for this one owned Instagram account.
async function diagnoseInstagramPublishing({ account, apiVersion, fetchImpl = fetch } = {}) {
  if (account?.username !== 'astel.us' || account?.platform !== 'instagram' ||
      account?.authMode !== 'facebook_login' || !/^\d+$/.test(String(account?.userId || '')) ||
      !/^v\d+\.\d+$/.test(apiVersion || '')) return { status: 'skipped', reason: 'DIAGNOSTIC_SCOPE_MISMATCH' };
  const candidates = [
    { source: 'configured_linked_page_token', token: account.linkedPageAccessToken },
    { source: 'configured_instagram_token', token: account.accessToken },
  ].filter(c => typeof c.token === 'string' && c.token);
  const secrets = candidates.map(c => c.token);
  const results = [], seen = new Set();
  async function read(token, path) {
    try {
      const res = await fetchImpl('https://graph.facebook.com/' + apiVersion + '/' + path, {
        method: 'GET', timeout: 10000, redirect: 'error',
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await res.json().catch(() => null);
      return { http: res.status, ok: res.ok && !!data && !data.error, data };
    } catch (_) { return { ok: false, network: true }; }
  }
  for (const candidate of candidates) {
    if (seen.has(candidate.token)) continue;
    seen.add(candidate.token);
    const result = { source: candidate.source };
    const id = encodeURIComponent(account.userId);
    const identity = await read(candidate.token, id + '?fields=id,username');
    result.identityMatched = !!(identity.ok && String(identity.data.id) === String(account.userId) &&
      identity.data.username === account.username);
    if (!identity.ok) result.identityError = safeGraphError(identity, secrets);
    // A successful Page-shaped read confirms the token's effective actor. A
    // failure does NOT establish its type; do not guess based on token prefixes.
    const actor = await read(candidate.token, 'me?fields=id,instagram_business_account');
    result.linkedPageConfirmed = actor.ok && !!actor.data.instagram_business_account?.id
      ? String(actor.data.instagram_business_account.id) === String(account.userId) : null;
    const permissions = await read(candidate.token, 'me/permissions?limit=100');
    if (permissions.ok && Array.isArray(permissions.data.data)) {
      result.permissions = {
        status: 'read', complete: !permissions.data.paging?.next,
        evidence: 'current_user_permission_edge_not_page_token_debug',
        relevant: permissions.data.data.filter(p => RELEVANT_PERMISSIONS.has(p.permission) &&
          ['granted', 'declined', 'expired'].includes(p.status))
          .map(p => ({ permission: p.permission, status: p.status })),
      };
    } else result.permissions = { status: 'unavailable', error: safeGraphError(permissions, secrets) };
    // Never probe publishing for an unverified target identity.
    if (result.identityMatched) {
      const quota = await read(candidate.token, id + '/content_publishing_limit?fields=quota_usage,config');
      result.quota = quota.ok ? { status: 'read' } : { status: 'denied', error: safeGraphError(quota, secrets) };
      if (!quota.ok && quota.http === 400) {
        const minimal = await read(candidate.token, id + '/content_publishing_limit');
        result.minimalQuota = minimal.ok ? { status: 'read' } : { status: 'denied', error: safeGraphError(minimal, secrets) };
      }
    }
    results.push(result);
  }
  return { status: 'completed', apiVersion, readOnly: true, selectedCredentialUnchanged: true, candidates: results };
}
module.exports = { diagnoseInstagramPublishing, safeGraphError };
