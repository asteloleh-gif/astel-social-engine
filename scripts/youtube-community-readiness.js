#!/usr/bin/env node
// Read-only operational probe. Does not load/start any Meta runtime or generator.
require("dotenv").config();
const { loadYouTubeAccount } = require("../app/accounts/accountConfig");
const { ASAP_GTA6_CHANNEL_ID } = require("../app/accounts/youtubeTarget");
const { createYouTubeProvider } = require("../app/providers/youtubeProvider");
async function main() {
  const account = loadYouTubeAccount(process.env);
  if (!account?.enabled) { console.log(JSON.stringify({status:"blocked",reason:"YOUTUBE_DISABLED_OR_UNCONFIGURED",liveTransportEnabled:false})); process.exitCode=2; return; }
  const provider = createYouTubeProvider({account,requiredChannelId:ASAP_GTA6_CHANNEL_ID});
  try {
    const identity = await provider.getAccountIdentity({force:true});
    const comments = identity.status === "ok" ? await provider.listCommentThreads({maxResults:20}) : null;
    const health = provider.health();
    console.log(JSON.stringify({status:identity.status === "ok" && comments?.status === "ok" ? "ok":"blocked",
      expectedChannelId:ASAP_GTA6_CHANNEL_ID,identity,health,
      commentList:comments ? {status:comments.status,reason:comments.reason||null,count:comments.items?.length||0,hasMore:Boolean(comments.nextPageToken)}:null,
      gate3:"NOT_REVIEWED",liveTransportEnabled:false},null,2));
    if(identity.status!=="ok" || comments?.status!=="ok")process.exitCode=2;
  } finally { await provider.close(); }
}
main().catch(()=>{console.error("YOUTUBE_READINESS_FAILED");process.exitCode=2;});
