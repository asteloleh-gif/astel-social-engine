'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { instagramPublishingAuth } = require('../app/calendar/instagramPublishingAuth');

test('calendar publishing credential is separate from existing comment credentials', () => {
  const account = Object.freeze({ userId: '123', authMode: 'facebook_login', accessToken: 'user-comment', linkedPageAccessToken: 'page-comment' });
  const auth = instagramPublishingAuth({ account, apiVersion: 'v26.0', publishingAccessToken: 'new-publishing-only' });
  assert.equal(auth.token, 'new-publishing-only');
  assert.equal(auth.baseUrl, 'https://graph.facebook.com');
  assert.equal(auth.userId, '123');
  assert.equal(account.accessToken, 'user-comment');
  assert.equal(account.linkedPageAccessToken, 'page-comment');
});

test('without a dedicated calendar token the previous Page fallback and API host remain unchanged', () => {
  const account = { userId: '123', authMode: 'facebook_login', accessToken: 'user-comment', linkedPageAccessToken: 'page-comment' };
  assert.equal(instagramPublishingAuth({ account, apiVersion: 'v26.0' }).token, 'page-comment');
  delete account.linkedPageAccessToken;
  assert.equal(instagramPublishingAuth({ account, apiVersion: 'v26.0' }).token, 'user-comment');
  account.authMode = 'instagram_login';
  const auth = instagramPublishingAuth({ account, apiVersion: 'v26.0', publishingAccessToken: 'direct-token' });
  assert.equal(auth.baseUrl, 'https://graph.instagram.com');
  assert.equal(auth.token, 'direct-token');
});
