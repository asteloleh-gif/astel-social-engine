'use strict';

// Dedicated publishing authorization never overwrites the community account.
// Existing identity/quota gates still verify this credential before any post.
function instagramPublishingAuth({ account, apiVersion, publishingAccessToken } = {}) {
  const facebookLogin = account?.authMode === 'facebook_login';
  const dedicated = String(publishingAccessToken || '').trim();
  return {
    status: 'ok', userId: account?.userId,
    token: dedicated || (facebookLogin
      ? (account?.linkedPageAccessToken || account?.accessToken) : account?.accessToken),
    baseUrl: facebookLogin ? 'https://graph.facebook.com' : 'https://graph.instagram.com',
    apiVersion,
  };
}
module.exports = { instagramPublishingAuth };
