'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseInstagramPublishing, safeGraphError } = require('../app/calendar/instagramAuthDiagnostics');
const pageToken = 'fake-page-secret';
const userToken = 'fake-user-secret';
const account = { platform: 'instagram', username: 'astel.us', userId: '123456789',
  authMode: 'facebook_login', accessToken: userToken, linkedPageAccessToken: pageToken };
const reply = (http, data) => ({ status: http, ok: http >= 200 && http < 300, json: async () => data });

test('IG publishing diagnosis: exact permission denial, read-only, credentials unchanged and unexposed', async () => {
  const original = JSON.stringify(account), calls = [];
  const result = await diagnoseInstagramPublishing({ account, apiVersion: 'v26.0', fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(opts.method, 'GET');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.body, undefined);
    assert.ok(!url.includes(pageToken) && !url.includes(userToken));
    if (url.includes('me/permissions')) {
      if (opts.headers.Authorization.endsWith(pageToken)) return reply(400, { error: { code: 100, message: 'No permissions field on Page' } });
      return reply(200, { data: [
        { permission: 'instagram_basic', status: 'granted' },
        { permission: 'instagram_content_publish', status: 'declined' },
        { permission: 'email', status: 'granted' },
      ] });
    }
    if (url.includes('instagram_business_account')) return reply(200, { id: '456', instagram_business_account: { id: account.userId } });
    if (url.includes('content_publishing_limit')) return reply(400, { error: {
      code: 10, message: '(#10) Requires instagram_content_publish. access_token=' + pageToken + ' Bearer ' + userToken,
      debug: { access_token: pageToken },
    } });
    return reply(200, { id: account.userId, username: 'astel.us' });
  } });
  assert.equal(result.candidates.length, 2);
  assert.equal(calls.length, 10);
  assert.equal(result.candidates[0].linkedPageConfirmed, true);
  assert.deepEqual(result.candidates[0].quota.error.namedPermissions, ['instagram_content_publish']);
  assert.equal(result.candidates[0].permissions.status, 'unavailable');
  assert.equal(result.candidates[1].permissions.relevant.length, 2);
  assert.equal(JSON.stringify(account), original);
  assert.doesNotMatch(JSON.stringify(result), /fake-page-secret|fake-user-secret|access_token=fake/);
});

test('IG publishing diagnosis does not query quota for another identity or scope', async () => {
  let calls = 0;
  const fetchImpl = async (url) => { calls++; assert.ok(!url.includes('content_publishing_limit'));
    return reply(200, { id: 'different', username: 'other' }); };
  const r = await diagnoseInstagramPublishing({ account, apiVersion: 'v26.0', fetchImpl });
  assert.ok(r.candidates.every(c => !c.identityMatched));
  assert.equal(calls, 6);
  const before = calls;
  assert.equal((await diagnoseInstagramPublishing({ account: { ...account, username: 'leoakastel' }, apiVersion: 'v26.0', fetchImpl })).status, 'skipped');
  assert.equal(calls, before);
});

test('IG publishing diagnosis deduplicates same token, does not infer missing scopes from a partial list', async () => {
  let calls = 0;
  const r = await diagnoseInstagramPublishing({ account: { ...account, accessToken: pageToken }, apiVersion: 'v26.0', fetchImpl: async url => {
    calls++;
    if (url.includes('me/permissions')) return reply(200, { data: [], paging: { next: 'https://graph.facebook.com/next?access_token=SECRET' } });
    if (url.includes('content_publishing_limit')) return reply(200, { data: [{ quota_usage: 0 }] });
    return reply(200, { id: account.userId, username: 'astel.us' });
  } });
  assert.equal(calls, 4);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].permissions.complete, false);
  assert.equal(r.candidates[0].linkedPageConfirmed, null);
  assert.doesNotMatch(JSON.stringify(r), /SECRET|paging|access_token/);
});

test('IG diagnostics never expose transport exceptions or Graph error credentials', async () => {
  const r = await diagnoseInstagramPublishing({ account, apiVersion: 'v26.0', fetchImpl: async () => { throw Error('token=' + pageToken); } });
  assert.doesNotMatch(JSON.stringify(r), /fake-page-secret/);
  const safe = safeGraphError({ http: 400, data: { error: { code: 10,
    message: 'access_token=abcde input_token=fghij Bearer klmno https://example.com/?secret=pqrst ' + 'A'.repeat(120),
    arbitrary_secret: 'uvwxyz', } } });
  assert.doesNotMatch(JSON.stringify(safe), /abcde|fghij|klmno|pqrst|uvwxyz|AAAA/);
  assert.equal(safe.code, 10);
});
