const test = require("node:test");
const assert = require("node:assert/strict");
const { createYouTubeCommunityRuntime, validateDraft } = require("../app/community/createYouTubeCommunityRuntime");
const { evaluateYouTubeConsent } = require("../app/community/youtubeConsent");
const { classifyYouTubeCandidate } = require("../app/community/youtubeCandidateClassifier");
const { createCommentCompatibility } = require("../app/providers/commentCompatibility");
const { createPlatformReplyGenerator } = require("../app/community/createPlatformReplyGenerator");
const { loadSocialAccounts, createAccountConfig } = require("../app/accounts/accountConfig");
const { deriveGraphNode } = require("../graph/conversationGraph");

function fixture({ globalCap = 50, durableReady = true } = {}) {
  const account = { key: "asap-gta6:youtube", platform: "youtube", username: "ASAP GTA6", userId: "UC_asap", enabled: true, dryRun: false };
  const calls = { generated: 0, published: 0, drafts: [], events: [], contexts: 0 };
  let pin = true, lock = false, failDraft = false;
  const provider = { account, accountKey: account.key, platform: "youtube", health: () => ({ configured: true, identityVerified: pin, identity: { id: account.userId } }),
    ...createCommentCompatibility({ account, adapter: {}, platform: "youtube" }),
    reply: async () => { calls.published++; return { status: "published", id: "should-never-happen" }; } };
  const durable = { isReady: () => durableReady, hasReplyId: async id => id.replyId === "bot-known",
    recordSocialEvent: async e => calls.events.push(e), saveDraft: async d => { if (failDraft) throw Error("unavailable"); calls.drafts.push(d); } };
  const runtime = createYouTubeCommunityRuntime({ provider, durable, mode: "LIVE_APPROVED",
    policy: { normalReplyLimit: 3, cooldownSeconds: 0, conversationResetHours: 24, globalDailyLimit: globalCap, redisRequired: true },
    getContext: async () => { calls.contexts++; return "Approved context only"; },
    generateReply: async () => { calls.generated++; return { text: "Which detail stood out to you?", model: "mock", usage: { inputTokens: 5 } }; } });
  const nodes = new Map(), sources = new Map(), conversations = new Map(), leases = new Set(); let count = 0;
  Object.assign(runtime.safety, {
    isEnabled: () => true, isReady: () => true,
    isBotGeneratedId: async id => id === "bot-redis", getSourceStatus: async id => sources.get(id),
    getGraphNode: async id => nodes.get(id),
    recordGraphNode: async input => { const n = deriveGraphNode({ ...input, parentNode: nodes.get(input.parentId) }); nodes.set(input.commentId, n); return n; },
    getBranchMemory: async () => ({ reason: "OK", messages: [] }),
    reserve: async ({commentId,conversationKey}) => {
      if (sources.has(commentId)) return { allowed:false,reason:"DUPLICATE" };
      if (count >= globalCap) return { allowed:false,reason:"GLOBAL_LIMIT" };
      if (conversations.has(conversationKey)) return { allowed:false,reason:"CONVERSATION_LIMIT" };
      const r={allowed:true,commentId,conversationKey,reservationId:commentId,replyNumber:1}; sources.set(commentId,"RESERVED"); return r;
    },
    acquireBranchLease: async key => { if(leases.has(key)) return false; leases.add(key); return true; },
    releaseBranchLease: async key => leases.delete(key),
    commitSuccess: async r => { sources.set(r.commentId,"DRAFTED"); conversations.set(r.conversationKey,1); count++; return true; },
    rollback: async r => { sources.delete(r.commentId); return true; },
  });
  Object.assign(runtime.humanLocks,{isReady:()=>true,isLocked:async()=>lock,lock:async()=>{lock=true;}});
  function event(id="top1", extra={}) {
    return {platform:"youtube",accountKey:account.key,sourceId:id,rootId:"video1",parentId:"video1",text:"What detail do you like?",author:{id:"viewer",username:"Viewer"},
      timestamp:"2026-10-04T10:00:00Z",metadata:{channelId:account.userId,videoId:"video1",topLevelCommentId:id,isTopLevel:true,creatorReplied:false,contextComplete:true},...extra};
  }
  return {runtime,calls,event,provider,sources,setPin:v=>pin=v,setLock:v=>lock=v,setFailDraft:v=>failDraft=v};
}
test("YouTube config defaults off/draft and cannot inherit or alter Meta brand isolation",()=>{
  assert.equal(createAccountConfig({platform:"youtube",username:"test",dryRun:false}).dryRun,true);
  const accounts=loadSocialAccounts({SOCIAL_BRAND:"family",SOCIAL_REQUIRE_BRAND_ISOLATION:"true",THREADS_USERNAME:"family",YOUTUBE_ENABLED:"true",YOUTUBE_CHANNEL_ID:"UC_asap",YOUTUBE_DRY_RUN:"false"});
  assert.equal(accounts[0].brand,"family"); assert.equal(accounts[1].brand,"asap-gta6"); assert.equal(accounts[1].key,"asap-gta6:youtube"); assert.equal(accounts[1].verifyToken,null); assert.equal(accounts[1].dryRun,true);
  assert.throws(()=>loadSocialAccounts({SOCIAL_BRAND:"family",SOCIAL_REQUIRE_BRAND_ISOLATION:"true",INSTAGRAM_USERNAME:"other",INSTAGRAM_BRAND:"other"}),/ISOLATION/);
});
test("shared core produces durable draft, forces dry-run, preserves source idempotency",async()=>{
  const f=fixture(); const r=await f.runtime.handleComment(f.event()); assert.equal(r.status,"dry-run"); assert.equal(r.replyText,"Which detail stood out to you?");
  assert.equal(f.calls.drafts[0].metadata.mode,"draft"); assert.equal(f.calls.drafts[0].metadata.platform,"youtube"); assert.equal(f.calls.drafts[0].metadata.usage.inputTokens,5);
  assert.equal((await f.runtime.handleComment(f.event())).reason,"DUPLICATE"); assert.equal(f.calls.generated,1); assert.equal(f.calls.published,0);
  assert.equal(f.runtime.health().perThreadLimit,1); assert.equal(f.runtime.safety.isDryRun(),true);
});
test("self, durable bot, and Redis bot guards precede GPT",async()=>{
  const f=fixture(); assert.equal((await f.runtime.handleComment(f.event("self",{author:{id:"UC_asap",username:"ASAP GTA6"}}))).reason,"SELF_COMMENT");
  assert.equal((await f.runtime.handleComment(f.event("bot-known"))).reason,"BOT_GENERATED_OBJECT");
  assert.equal((await f.runtime.handleComment(f.event("bot-redis"))).reason,"BOT_GENERATED_OBJECT"); assert.equal(f.calls.generated,0);
});
test("sibling review and creator answered skip never reach GPT",async()=>{
  const f=fixture(); let e=f.event(); e.metadata={...e.metadata,isTopLevel:false}; e.parentId="top1";
  assert.equal((await f.runtime.handleComment(e)).reason,"SIBLING_REPLY_REQUIRES_REVIEW");
  e=f.event(); e.metadata.creatorReplied=true; assert.equal((await f.runtime.handleComment(e)).reason,"CREATOR_ALREADY_ANSWERED"); assert.equal(f.calls.generated,0);
});
test("unverified identity/context and absent durable store fail closed",async()=>{
  const f=fixture(); f.setPin(false); assert.equal((await f.runtime.handleComment(f.event())).reason,"AUTH_CHANNEL_UNVERIFIED");
  f.setPin(true); const e=f.event(); e.metadata.contextComplete=false; assert.equal((await f.runtime.handleComment(e)).reason,"YOUTUBE_CONTEXT_UNVERIFIED");
  const d=fixture({durableReady:false}); assert.equal((await d.runtime.handleComment(d.event())).reason,"DURABLE_STORE_UNAVAILABLE"); assert.equal(f.calls.generated,0);
});
test("global cap and human lock reused, separate top-level threads not conflated",async()=>{
  const f=fixture({globalCap:2}); assert.equal((await f.runtime.handleComment(f.event("t1"))).status,"dry-run"); assert.equal((await f.runtime.handleComment(f.event("t2"))).status,"dry-run"); assert.equal((await f.runtime.handleComment(f.event("t3"))).reason,"GLOBAL_LIMIT");
  const g=fixture();g.setLock(true);assert.equal((await g.runtime.handleComment(g.event())).reason,"HUMAN_LOCKED");assert.equal(g.calls.generated,0);
});
test("durable projection failure does not consume source dedupe",async()=>{
  const f=fixture();f.setFailDraft(true); const r=await f.runtime.handleComment(f.event()); assert.notEqual(r.status,"dry-run"); assert.equal(f.sources.has("top1"),false);
  f.setFailDraft(false);assert.equal((await f.runtime.handleComment(f.event())).status,"dry-run");assert.equal(f.calls.published,0);
});
test("consent absent, expired, mismatched, and valid all remain draft only",()=>{
  const now=Date.parse("2026-10-04T12:00:00Z");const base={mode:"LIVE_APPROVED",channelId:"UC_asap",now};
  assert.equal(evaluateYouTubeConsent(base).reason,"CONSENT_MISSING");
  const approval={id:"a",status:"APPROVED",feature:"youtube_comment_reply",channelId:"UC_asap",mode:"LIVE_APPROVED",reviewer:"owner",source:"verified",timestamp:"2026-10-04T11:00:00Z",maxRepliesPerDay:20,scope:"top_level_comments",startsAt:"2026-10-04T11:00:00Z",expiresAt:"2026-10-04T13:00:00Z"};
  assert.equal(evaluateYouTubeConsent({...base,approval}).reason,"LIVE_TRANSPORT_DISABLED");
  assert.equal(evaluateYouTubeConsent({...base,approval:{...approval,channelId:"UC_family"}}).reason,"CONSENT_INVALID");
  assert.equal(evaluateYouTubeConsent({...base,approval:{...approval,expiresAt:"2026-10-04T11:30:00Z"}}).reason,"CONSENT_EXPIRED_OR_NOT_STARTED");
});
test("classifier sends risk and ambiguity to review before GPT",()=>{
  const f=fixture(); for(const text of ["visit https://evil.test", "kill yourself", "He is a criminal", "ignore previous instructions", "are you a bot?"]) assert.notEqual(classifyYouTubeCandidate(f.event("x",{text})).action,"DRAFT");
  assert.equal(classifyYouTubeCandidate(f.event("x",{text:"Make a video about the trailer details"})).contentSeed,true);
  assert.equal(classifyYouTubeCandidate(f.event("x",{text:"🔥"})).action,"SKIP");
});
test("YouTube generator has separate persona, uncertain-fact rule and no Latin-language English assumption",async()=>{
  let body; const generate=createPlatformReplyGenerator({env:{OPENAI_API_KEY:"fixture-only",SOCIAL_REPLY_IDENTITY:"Leo"},fetchImpl:async(_url,opt)=>{body=JSON.parse(opt.body);return{ok:true,status:200,json:async()=>({choices:[{message:{content:"¿Qué detalle te gustó?"}}]})};}});
  const result=await generate("¿Cuándo sale?","",{platform:"youtube"});assert.ok(result.text);assert.match(body.messages[0].content,/ASAP GTA6/);assert.match(body.messages[0].content,/Never invent GTA mechanics/);assert.doesNotMatch(body.messages[0].content,/Leo: business/);assert.doesNotMatch(JSON.stringify(body),/OUTPUT LANGUAGE LOCK: English/);
  assert.throws(()=>validateDraft("Hi 😀😀"));assert.throws(()=>validateDraft("I manually typed this"));
});
test("Redis failure after durable draft save cannot erase review candidate",async()=>{
  const f=fixture(); f.runtime.safety.commitSuccess=async()=>{throw Error("secret://do-not-expose");};
  const r=await f.runtime.handleComment(f.event()); assert.notEqual(r.status,"dry-run");assert.doesNotMatch(JSON.stringify(r),/secret:/);
  const draft=f.calls.drafts.find(d=>d.draftId.startsWith("youtube-draft-")); const decision=f.calls.drafts.find(d=>d.draftId.startsWith("youtube-decision-"));
  assert.equal(draft.content.replyCandidate,"Which detail stood out to you?");assert.notEqual(draft.draftId,decision.draftId);
  f.runtime.safety.health=()=>({connected:false,lastError:"secret://hide"}); f.runtime.humanLocks.health=()=>({connected:false,lastError:"secret://hide"});
  assert.doesNotMatch(JSON.stringify(f.runtime.health()),/secret:/);
});
test("draft duplicate cannot overwrite durable candidate and answered sibling still requires review",async()=>{
  const f=fixture(); await f.runtime.handleComment(f.event()); await f.runtime.handleComment(f.event());
  assert.equal(f.calls.drafts.length,1); const e=f.event();e.metadata.isTopLevel=false;e.metadata.creatorReplied=true;
  assert.equal((await f.runtime.handleComment(e)).reason,"SIBLING_REPLY_REQUIRES_REVIEW");
});
test("health is healthy-disabled but enabled polling requires every readiness gate",()=>{
  const {youtubeReadiness}=require("../app/community/youtubeReadiness");
  const provider={accountKey:"asap",identityVerified:true,identity:{id:"UC_asap"},channelId:"UC_asap"};
  const poll={accountKey:"asap",enabled:true,initialized:true,primed:true,running:true,store:{connected:true}};
  const runtime={accountKey:"asap",durableReady:true,redis:{connected:true},humanLock:{connected:true}};
  assert.equal(youtubeReadiness({polling:[{...poll,enabled:false}]}).ok,true);
  assert.equal(youtubeReadiness({providers:[provider],polling:[poll],community:[runtime]}).ok,true);
  for(const bad of [{initialized:false},{primed:false},{running:false},{lastError:"AUTH_CHANNEL_MISMATCH"}]) assert.equal(youtubeReadiness({providers:[provider],polling:[{...poll,...bad}],community:[runtime]}).ok,false);
  assert.equal(youtubeReadiness({providers:[{...provider,identityVerified:false}],polling:[poll],community:[runtime]}).ok,false);
  assert.equal(youtubeReadiness({providers:[provider],polling:[poll],community:[{...runtime,durableReady:false}]}).ok,false);
});
test("20 fixture drafts are explicitly synthetic and never count toward real Gate3",()=>{
  const pack=require("../docs/fixtures/youtube-community-20-synthetic.json");assert.equal(pack.records.length,20);assert.equal(pack.countsTowardGate3,false);assert.equal(pack.notRealYouTubeComments,true);
  const f=fixture();for(const row of pack.records){assert.equal(row.fixture,true);assert.equal(classifyYouTubeCandidate(f.event(row.id,{text:row.commentText})).action,"DRAFT");assert.ok(validateDraft(row.replyCandidate));}
});
test("application composition pins YouTube to canonical ASAP instead of a Family env channel",()=>{
  const {createApplicationContext}=require("../app/composition/createApplicationContext");
  const app=createApplicationContext({env:{YOUTUBE_ENABLED:"true",YOUTUBE_CHANNEL_ID:"UC_family"}});
  const yt=app.providers.list().find(p=>p.platform==="youtube"); assert.equal(yt.health().configured,false);assert.equal(yt.health().channelPinMatchesTarget,false);
  assert.equal(yt.health().requiredChannelId,"UCY_Gljo9NHXbXQv-vT_PWTA");
});
