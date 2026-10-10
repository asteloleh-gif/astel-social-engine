"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseRecord,mediaUrl,errorCode}=require('../app/calendar/contract');
const {createCalendarWorker}=require('../app/calendar/worker');
const {createPublicationCalendar}=require('../app/calendar/runtime');
const {createCalendarMetaPublisher}=require('../app/calendar/metaPublisher');
const {createCalendarAirtable}=require('../app/calendar/airtableClient');
const NOW=new Date('2026-10-10T18:00:00.000Z');
const id='rec1234567890abcd';
function row(overrides={}) {return {id,fields:{Title:'Test draft',Platform:'Threads',Format:'Text',Caption:'Test caption',
  'Scheduled At':'2026-10-10T13:00:00-05:00',Approval:'Request review','Delivery Mode':'Simulation',Revision:1,...overrides}};}
function memoryStore() {
  const map=new Map();let ready=false;
  const bump=j=>{j.syncVersion++;j.dirty=true;j.updatedAt=NOW.toISOString();};
  return {map,async init(){ready=true;},isReady:()=>ready,health:()=>({connected:ready}),
    async get(id){const x=map.get(id);return x?structuredClone(x):null;},
    async stage(c){
      if([...map.values()].some(j=>j.recordId===c.recordId&&j.status==='PROCESSING'))throw Error('RECORD_ALREADY_PROCESSING');
      for(const j of map.values())if(j.recordId===c.recordId&&j.id!==c.id&&['DRAFT','PENDING'].includes(j.status)){j.status='CANCELLED';bump(j);j.dirty=false;}
      if(!map.has(c.id))map.set(c.id,{...structuredClone(c),status:'DRAFT',result:{},dirty:true,syncVersion:1,createdAt:NOW.toISOString(),updatedAt:NOW.toISOString(),metadata:{deliveryMode:c.mode}});
      return this.get(c.id);
    },
    async approve(id,hash,reviewer){const j=map.get(id);if(!j||j.status!=='DRAFT'||j.hash!==hash)return false;j.status='PENDING';j.reviewer=reviewer;bump(j);return true;},
    async due(now,limit){return [...map.values()].filter(j=>j.status==='PENDING'&&Date.parse(j.scheduledAt)<=now.getTime()).slice(0,limit).map(j=>j.id);},
    async claim(id,token,{now,leaseMs}){const j=map.get(id);if(!j||j.status!=='PENDING'||Date.parse(j.scheduledAt)>now.getTime())return false;j.status='PROCESSING';j.claim=token;j.lease=now.getTime()+leaseMs;bump(j);return true;},
    async verifyLease(id,token,now){const j=map.get(id);return !!(j&&j.status==='PROCESSING'&&j.claim===token&&j.lease>now.getTime());},
    async checkpoint(id,token,patch){const j=map.get(id);if(!j||j.claim!==token||j.status!=='PROCESSING')throw Error('CALENDAR_LEASE_LOST');Object.assign(j.result,patch);bump(j);},
    async finish(id,token,status,{result={},errorCode=null}){const j=map.get(id);if(!j||j.status!=='PROCESSING'||j.claim!==token)return false;j.status=status;Object.assign(j.result,result);j.errorCode=errorCode;bump(j);return true;},
    async recoverExpired(now){let n=0;for(const j of map.values())if(j.status==='PROCESSING'&&j.lease<=now.getTime()){j.status='AMBIGUOUS_HOLD';bump(j);n++;}return n;},
    async cancelRecord(recordId){for(const j of map.values())if(j.recordId===recordId&&['DRAFT','PENDING'].includes(j.status)){j.status='CANCELLED';bump(j);}},
    async dirtyJobs(){return [...map.values()].filter(j=>j.dirty).map(j=>structuredClone(j));},
    async markSynced(id,version){const j=map.get(id);if(j?.syncVersion===version)j.dirty=false;},
    async counts(){const c={};for(const j of map.values())c[j.status]=(c[j.status]||0)+1;return c;}
  };
}
function harness({record=row(),liveEnabled=false,publish,now=()=>NOW}={}) {
  const repository=memoryStore();let sent=0,failWrites=false,failReads=false;
  const records=new Map([[record.id,record]]);
  const airtable={async list(){if(failReads)throw Error('CALENDAR_AIRTABLE_HTTP_503');return [...records.values()].map(x=>structuredClone(x));},
    async get(id){if(failReads)throw Error('CALENDAR_AIRTABLE_HTTP_503');return structuredClone(records.get(id));},
    async patch(id,fields){if(failWrites)throw Error('CALENDAR_AIRTABLE_HTTP_503');Object.assign(records.get(id).fields,fields);}};
  const providers=new Map(['threads','instagram'].map(platform=>[`astel.us:${platform}`,{platform,account:{enabled:true,dryRun:false},capabilities:{publishPosts:true},health:()=>({configured:true}),
    async publishPost(c,ctx){sent++;return publish?publish(c,ctx):{status:'published',id:'post123',permalink:'https://www.threads.net/@astel.us/post/example'};}}]));
  const worker=createCalendarWorker({repository,airtable,providers,liveEnabled,now,logger:{log(){},error(){}}});
  return {worker,repository,record,get sent(){return sent;},setFailWrites:x=>failWrites=x,setFailReads:x=>failReads=x};
}
async function reviewAndApprove(h){await h.worker.init();await h.worker.runOnce();h.record.fields.Approval='Approved';h.record.fields.Reviewer='test-operator';}

test('calendar canonicalizes timezone; changing caption or time invalidates approval',()=>{
 const r=row();const c=parseRecord(r);assert.equal(c.scheduledAt,NOW.toISOString());
 assert.notEqual(parseRecord(row({Caption:'Changed'})).hash,c.hash);
 assert.notEqual(parseRecord(row({'Scheduled At':'2026-10-10T14:00:00-05:00'})).hash,c.hash);
 assert.notEqual(parseRecord(row({'Delivery Mode':'Live'})).id,c.id);
});
test('calendar rejects Facebook, Instagram text, unsupported Threads media, missing timezone and empty mode',()=>{
 for(const f of [{Platform:'Facebook'},{Platform:'Instagram',Format:'Text'},{Format:'Image'},{'Scheduled At':'2026-10-10 13:00'},{'Delivery Mode':''}])assert.throws(()=>parseRecord(row(f)));
});
test('media URL validation rejects local/internal hosts, IP literals, embedded credentials and share pages',()=>{
 for(const u of ['http://a.com/a.jpg','https://127.0.0.1/a','https://[::1]/a','https://a.internal/a','https://u:p@example.com/a','https://drive.google.com/file/d/x/view','https://a.com:8443/a'])assert.throws(()=>mediaUrl(u));
 assert.equal(mediaUrl('https://cdn.example.com/photo.jpg'),'https://cdn.example.com/photo.jpg');
});
test('calendar enforces caption and revision bounds',()=>{
 assert.throws(()=>parseRecord(row({Caption:'x'.repeat(501)})));
 assert.throws(()=>parseRecord(row({Revision:-1})));
 assert.throws(()=>parseRecord(row({Platform:'Instagram',Format:'Image','Media URL':'https://cdn.example.com/a.jpg',Caption:'a'.repeat(2201)})));
});
test('diagnostics never echo credential-bearing transport errors',()=>{
 assert.equal(errorCode(Error('request failed https://host?access_token=secret')),'CALENDAR_OPERATION_FAILED');
});
test('review → explicit approval → due simulation; replay sends zero Meta calls',async()=>{
 const h=harness();await reviewAndApprove(h);assert.equal(h.record.fields.Result,'AWAITING_APPROVAL');
 await h.worker.runOnce();assert.equal(h.record.fields.Result,'SIMULATED');assert.equal(h.sent,0);
 await h.worker.runOnce();assert.equal(h.sent,0);assert.equal(h.repository.map.size,1);
});
test('Instagram Image and Reel simulations use the same scheduler without media upload',async()=>{
 for(const Format of ['Image','Reel']){
 const h=harness({record:row({Platform:'Instagram',Format,'Media URL':'https://cdn.example.com/media'})});
 await reviewAndApprove(h);await h.worker.runOnce();assert.equal(h.record.fields.Result,'SIMULATED');assert.equal(h.sent,0);
 }
});
test('future jobs remain scheduled, never run early',async()=>{
 const h=harness({record:row({'Scheduled At':'2026-10-11T13:00:00-05:00'})});
 await reviewAndApprove(h);await h.worker.runOnce();assert.equal(h.record.fields.Result,'SCHEDULED');assert.equal(h.sent,0);
});
test('live jobs cannot be consumed as simulations or published by a simulation-only runtime',async()=>{
 const h=harness({record:row({'Delivery Mode':'Live'})});await reviewAndApprove(h);await h.worker.runOnce();
 assert.equal(h.record.fields.Result,'BLOCKED_LIVE_RELEASE');assert.equal(h.sent,0);assert.equal([...h.repository.map.values()][0].status,'DRAFT');
});
test('changed content after review requires another review, no post',async()=>{
 const h=harness({liveEnabled:true,record:row({'Delivery Mode':'Live'})});await reviewAndApprove(h);h.record.fields.Caption='changed after review';
 await h.worker.runOnce();assert.equal(h.sent,0);assert.equal(h.record.fields.Approval,'Draft');
});
test('missing explicit reviewer blocks approval',async()=>{
 const h=harness();await h.worker.init();await h.worker.runOnce();h.record.fields.Approval='Approved';await h.worker.runOnce();
 assert.equal(h.sent,0);assert.equal(h.record.fields.Approval,'Draft');
});
test('withdrawn approval and cancellation prevent a pending post',async()=>{
 const h=harness({record:row({'Scheduled At':'2026-10-11T00:00:00Z'})});await reviewAndApprove(h);await h.worker.runOnce();
 h.record.fields.Approval='Cancelled';await h.worker.runOnce();assert.equal(h.record.fields.Result,'CANCELLED');assert.equal(h.sent,0);
});
test('Airtable failure blocks dispatch, even with queued work',async()=>{
 const h=harness();await reviewAndApprove(h);h.setFailReads(true);const r=await h.worker.runOnce();assert.equal(r.status,'error');assert.equal(h.sent,0);
});
test('fake live provider publishes once; result writeback outage never reposts',async()=>{
 const h=harness({liveEnabled:true,record:row({'Delivery Mode':'Live'}),publish:async()=>{h.setFailWrites(true);return {status:'published',id:'real-id'};}});
 await reviewAndApprove(h);await h.worker.runOnce();assert.equal(h.sent,1);
 h.setFailWrites(false);await h.worker.runOnce();assert.equal(h.sent,1);assert.equal(h.record.fields['Published ID'],'real-id');
});
test('ambiguous publish is held and never retried',async()=>{
 const h=harness({liveEnabled:true,record:row({'Delivery Mode':'Live'}),publish:async()=>({status:'ambiguous',reason:'NETWORK_OUTCOME_UNKNOWN'})});
 await reviewAndApprove(h);await h.worker.runOnce();await h.worker.runOnce();assert.equal(h.sent,1);assert.equal(h.record.fields.Result,'AMBIGUOUS_HOLD');
});
test('restart preserves persisted pending jobs and expired work goes to hold, not replay',async()=>{
 const repo=memoryStore();await repo.init();const c=parseRecord(row());await repo.stage(c);await repo.approve(c.id,c.hash,'operator');
 assert.equal(await repo.claim(c.id,'a',{now:NOW,leaseMs:10}),true);
 assert.equal(await repo.claim(c.id,'b',{now:NOW,leaseMs:10}),false);
 assert.equal(await repo.recoverExpired(new Date(NOW.getTime()+20)),1);
 assert.equal((await repo.get(c.id)).status,'AMBIGUOUS_HOLD');
});
test('missed live schedule does not release a historical backlog',async()=>{
 const h=harness({liveEnabled:true,record:row({'Delivery Mode':'Live','Scheduled At':'2026-10-10T10:00:00Z'})});
 await reviewAndApprove(h);await h.worker.runOnce();assert.equal(h.sent,0);assert.equal(h.record.fields.Error,'MISSED_SCHEDULE_REVIEW_REQUIRED');
});
test('calendar disabled by default; no dependencies or community flags changed',async()=>{
 const env={BOT_ENABLED:'true',INSTAGRAM_ENABLED:'true',FACEBOOK_ENABLED:'false'};const copy={...env};
 const rt=createPublicationCalendar({env});assert.equal((await rt.start()).reason,'CALENDAR_DISABLED');assert.deepEqual(env,copy);
});
test('calendar refuses non-US account binding',async()=>{
 const rt=createPublicationCalendar({env:{CALENDAR_ENABLED:'true',CALENDAR_BRAND:'astel.us'},socialContext:{primaryAccount:{brand:'leoakastel'}},logger:{error(){}}});
 assert.equal((await rt.start()).reason,'CALENDAR_WRONG_BRAND');
});

function response(status,data){return {ok:status>=200&&status<300,status,json:async()=>data};}
function metaHarness({platform='instagram',states=['FINISHED'],outcome='success',mismatch=false,guardFails=false}={}){
 const calls=[],checkpoints=[];let check=0,guardCalls=0;
 const account={userId:'123',username:'astel.us'};
 const p=createCalendarMetaPublisher({platform,account,pollMs:1,sleep:async()=>{},getAuth:async()=>({status:'ok',token:'SECRET',userId:'123',apiVersion:'v25.0',baseUrl:platform==='threads'?'https://graph.threads.net':'https://graph.facebook.com'}),
 fetchImpl:async(url,opts)=>{
  calls.push({url,opts});assert.doesNotMatch(url,/SECRET/);assert.equal(opts.headers.Authorization,'Bearer SECRET');
  if(url.includes('fields=id,username'))return response(200,{id:mismatch?'wrong':'123',username:'astel.us'});
  if(url.includes('publishing_limit'))return response(200,{data:[{quota_usage:0,config:{quota_total:100}}]});
  if(opts.method==='POST'&&!url.includes('_publish'))return response(200,{id:'container'});
  if(url.includes('fields=status'))return response(200,{[platform==='threads'?'status':'status_code']:states[Math.min(check++,states.length-1)]});
  if(url.includes('_publish')){if(outcome==='network')throw Error('request SECRET');return outcome==='permission'?response(403,{error:{code:200,error_subcode:7}}):response(200,{id:'post'});}
  return response(200,{id:'post',permalink:'https://www.instagram.com/p/xyz/'});
 }});
 const ctx={async beforeMutation(){guardCalls++;if(guardFails&&guardCalls===2)throw Error('APPROVAL_WITHDRAWN');},async checkpoint(x){checkpoints.push(x);}};
 return {p,calls,checkpoints,ctx};
}
test('Instagram JPEG and Reel container→readiness→single publish, checkpoint before mutation',async()=>{
 for(const type of ['image','reel']){
 const h=metaHarness({states:['IN_PROGRESS','FINISHED']});const r=await h.p.publishPost({type,text:'Caption',mediaUrl:'https://cdn.example.com/asset'},h.ctx);
 assert.equal(r.status,'published');assert.equal(r.id,'post');assert.equal(r.readbackConfirmed,true);
 assert.equal(h.calls.filter(x=>x.url.includes('/media_publish')).length,1);
 assert.equal(h.checkpoints.at(-1).phase,'PUBLISH_INTENT');
 const create=h.calls.find(x=>x.opts.method==='POST'&&!x.url.includes('_publish'));
 if(type==='reel')assert.equal(create.opts.body.get('media_type'),'REELS');else assert.equal(create.opts.body.get('image_url'),'https://cdn.example.com/asset');
 }
});
test('Threads readiness is checked before posting; text only',async()=>{
 const h=metaHarness({platform:'threads'});assert.equal((await h.p.publishPost({type:'text',text:'Hello'},h.ctx)).status,'published');
 const ix=h.calls.findIndex(x=>x.url.includes('fields=status'));const pub=h.calls.findIndex(x=>x.opts.method==='POST' && x.url.includes('/threads_publish'));assert.ok(ix<pub);
});
test('identity mismatch and missing lease guards prevent all mutations',async()=>{
 const h=metaHarness({mismatch:true});assert.equal((await h.p.publishPost({type:'image',mediaUrl:'https://cdn.example.com/a.jpg'},h.ctx)).reason,'PUBLISH_ACCOUNT_IDENTITY_MISMATCH');
 assert.equal(h.calls.filter(x=>x.opts.method==='POST').length,0);
 assert.equal((await h.p.publishPost({type:'image'})).reason,'PUBLISH_LEASE_GUARD_REQUIRED');
});
test('container terminal states and readiness timeout never call media_publish',async()=>{
 for(const state of ['ERROR','EXPIRED','IN_PROGRESS','BOGUS']){
 const h=metaHarness({states:[state]});const r=await h.p.publishPost({type:'image',mediaUrl:'https://cdn.example.com/a.jpg'},h.ctx);
 assert.equal(r.status,'failed');assert.equal(h.calls.filter(x=>x.url.includes('/media_publish')).length,0);
 }
});
test('already published container is held rather than recreated',async()=>{
 const h=metaHarness({states:['PUBLISHED']});assert.equal((await h.p.publishPost({type:'reel',mediaUrl:'https://cdn.example.com/a.mp4'},h.ctx)).status,'ambiguous');
 assert.equal(h.calls.filter(x=>x.url.includes('/media_publish')).length,0);
});
test('final approval withdrawal stops publication after container processing',async()=>{
 const h=metaHarness({guardFails:true});const r=await h.p.publishPost({type:'image',mediaUrl:'https://cdn.example.com/a.jpg'},h.ctx);
 assert.equal(r.reason,'APPROVAL_WITHDRAWN');assert.equal(h.calls.filter(x=>x.url.includes('/media_publish')).length,0);
});
test('network outcome is held; permission rejection records safe codes',async()=>{
 for(const outcome of ['network','permission']){
 const h=metaHarness({outcome});const r=await h.p.publishPost({type:'image',mediaUrl:'https://cdn.example.com/a.jpg'},h.ctx);
 assert.equal(r.status,outcome==='network'?'ambiguous':'failed');assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 if(outcome==='permission')assert.equal(r.subcode,7);
 assert.equal(h.calls.filter(x=>x.url.includes('/media_publish')).length,1);
 }
});
test('read-only preflight does not create or publish containers',async()=>{
 const h=metaHarness();const r=await h.p.preflight();assert.equal(r.identityVerified,true);
 assert.equal(r.publishingPermission,'not_confirmed_by_read_only_probe');assert.equal(h.calls.some(x=>x.opts.method==='POST'),false);
});
test('Airtable client paginates and keeps tokens out of URLs/errors',async()=>{
 let n=0;
 const c=createCalendarAirtable({apiKey:'AIRTABLE_SECRET',baseId:'app1234567890abcd',tableId:'tbl1234567890abcd',sleep:async()=>{},
 fetchImpl:async(url,opts)=>{n++;assert.doesNotMatch(url,/AIRTABLE_SECRET/);assert.equal(opts.redirect,'error');return response(200,n===1?{records:[row()],offset:'next'}:{records:[]});}});
 assert.equal((await c.list()).length,1);assert.equal(n,2);
});
