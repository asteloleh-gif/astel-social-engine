"use strict";
const fetch = require("node-fetch");
const { mediaUrl, errorCode } = require("./contract");

function createCalendarMetaPublisher({ platform, account, getAuth, fetchImpl=fetch,
  sleep=ms=>new Promise(r=>setTimeout(r,ms)), pollMs=60000, maxChecks=5 }={}) {
  if(!['threads','instagram'].includes(platform) || typeof getAuth!=='function') throw new Error("INVALID_PUBLISHER_CONFIG");
  const failure=(reason,details={})=>({status:'failed',reason,...details});
  async function request(auth,path,method='GET',body=null) {
    const host=auth.baseUrl;
    if(!['https://graph.facebook.com','https://graph.instagram.com','https://graph.threads.net'].includes(host)) throw new Error("INVALID_META_HOST");
    if(!/^v\d+\.\d+$/.test(auth.apiVersion||''))throw new Error("INVALID_META_VERSION");
    try {
      const res=await fetchImpl(`${host}/${auth.apiVersion}/${path}`,{method,timeout:20000,redirect:'error',headers:{
        Authorization:`Bearer ${auth.token}`, ...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})
      },...(body?{body:new URLSearchParams(body)}:{})});
      const data=await res.json().catch(()=>null);
      return {http:res.status,ok:res.ok && data && !data.error,data};
    }catch(_){return {network:true,ok:false};}
  }
  function safeError(r) {
    return {httpStatus:r.http||null,code:r.data?.error?.code??null,subcode:r.data?.error?.error_subcode??null};
  }
  async function verifiedAuth() {
    const auth=await getAuth();
    if(auth?.status!=='ok' || !auth.token || !auth.userId) throw new Error(errorCode(auth?.reason,'PUBLISH_AUTH_UNAVAILABLE'));
    const path=platform==='threads'?'me':encodeURIComponent(auth.userId);
    const r=await request(auth,path+'?fields=id,username');
    if(!r.ok)throw new Error(`PUBLISH_IDENTITY_HTTP_${r.http||0}_CODE_${r.data?.error?.code||0}`);
    const actual=String(r.data.username||'').replace(/^@/,'').toLowerCase();
    if(String(r.data.id)!==String(account.userId) || actual!==String(account.username||'').replace(/^@/,'').toLowerCase()) throw new Error("PUBLISH_ACCOUNT_IDENTITY_MISMATCH");
    return auth;
  }
  async function preflight() {
    try {
      const auth=await verifiedAuth();
      const edge=platform==='threads'?'threads_publishing_limit':'content_publishing_limit';
      const r=await request(auth,encodeURIComponent(auth.userId)+'/'+edge+'?fields=quota_usage,config');
      if(!r.ok)return failure('PUBLISH_QUOTA_UNREADABLE',safeError(r));
      const quota=r.data?.data?.[0];
      if(!quota || !Number.isFinite(Number(quota.quota_usage)) || !Number.isFinite(Number(quota.config?.quota_total))) return failure('PUBLISH_QUOTA_UNVERIFIED');
      if(Number(quota.quota_usage)>=Number(quota.config.quota_total))return failure('PUBLISH_QUOTA_EXHAUSTED');
      return {status:'ok',username:account.username,identityVerified:true,
        quotaUsage:Number(quota.quota_usage),quotaTotal:Number(quota.config.quota_total),
        publishingPermission:'not_confirmed_by_read_only_probe'};
    }catch(e){return failure(errorCode(e));}
  }
  async function publishPost(content,context={}) {
    if(typeof context.beforeMutation!=='function' || typeof context.checkpoint!=='function')return failure('PUBLISH_LEASE_GUARD_REQUIRED');
    const c=content||{};
    if(platform==='threads' && c.type!=='text')return failure('THREADS_TEXT_ONLY');
    if(platform==='instagram' && !['image','reel'].includes(c.type))return failure('INSTAGRAM_IMAGE_OR_REEL_REQUIRED');
    try { if(platform==='instagram')mediaUrl(c.mediaUrl); }catch(e){return failure(errorCode(e));}
    let auth;
    try { auth=await verifiedAuth(); }catch(e){return failure(errorCode(e));}
    const edge=platform==='threads'?'threads_publishing_limit':'content_publishing_limit';
    const quota=await request(auth,encodeURIComponent(auth.userId)+'/'+edge+'?fields=quota_usage,config');
    const q=quota.data?.data?.[0];
    if(!quota.ok || !q || !Number.isFinite(Number(q.quota_usage)) || !Number.isFinite(Number(q.config?.quota_total))) return failure('PUBLISH_QUOTA_UNVERIFIED',safeError(quota));
    if(Number(q.quota_usage)>=Number(q.config.quota_total))return failure('PUBLISH_QUOTA_EXHAUSTED');
    try { await context.beforeMutation(); }catch(e){return failure(errorCode(e,'PUBLISH_GUARD_REJECTED'));}
    const params=platform==='threads'?{media_type:'TEXT',text:c.text}:
      {caption:c.text||'',...(c.type==='image'?{image_url:c.mediaUrl}:{media_type:'REELS',video_url:c.mediaUrl,share_to_feed:'true'})};
    const prefix=encodeURIComponent(auth.userId);
    const created=await request(auth,prefix+(platform==='threads'?'/threads':'/media'),'POST',params);
    // Creation is deliberately never auto-published. A lost creation response cannot be a post.
    if(!created.ok || !created.data?.id)return failure('CONTAINER_CREATE_FAILED',safeError(created));
    const creationId=String(created.data.id);
    try { await context.checkpoint({creationId,phase:'CONTAINER_CREATED'}); }
    catch(_){return {status:'ambiguous',reason:'CONTAINER_CHECKPOINT_FAILED',creationId};}
    const statusField=platform==='threads'?'status':'status_code';
    let ready=false;
    // Meta recommends about 30 seconds for Threads processing, then bounded status checks.
    if(platform==='threads')await sleep(30000);
    for(let i=0;i<Math.max(1,Math.min(5,maxChecks));i++) {
      const r=await request(auth,encodeURIComponent(creationId)+'?fields='+statusField);
      if(!r.ok)return failure('CONTAINER_STATUS_UNREADABLE',{creationId,...safeError(r)});
      const state=r.data?.[statusField];
      if(state==='FINISHED'){ready=true;break;}
      if(state==='PUBLISHED')return {status:'ambiguous',reason:'CONTAINER_ALREADY_PUBLISHED',creationId};
      if(['ERROR','EXPIRED'].includes(state))return failure('CONTAINER_'+state,{creationId});
      if(state!=='IN_PROGRESS')return failure('CONTAINER_STATUS_UNKNOWN',{creationId});
      if(i<maxChecks-1)await sleep(pollMs);
    }
    if(!ready)return failure('CONTAINER_NOT_READY_TIMEOUT',{creationId});
    try {
      // Persist BEFORE the externally visible mutation and re-check approval/lease at the boundary.
      await context.checkpoint({creationId,phase:'PUBLISH_INTENT'});
      await context.beforeMutation();
    }catch(e){return failure(errorCode(e,'PUBLISH_GUARD_REJECTED'),{creationId});}
    const published=await request(auth,prefix+(platform==='threads'?'/threads_publish':'/media_publish'),'POST',{creation_id:creationId});
    if(published.network || published.http===429 || published.http>=500 || !published.data || (published.ok && !published.data.id)) {
      return {status:'ambiguous',reason:'PUBLISH_OUTCOME_UNKNOWN',creationId,...safeError(published)};
    }
    if(!published.ok)return failure('META_PUBLISH_REJECTED',{creationId,...safeError(published)});
    const id=String(published.data.id);
    // An ID returned by publish is authoritative. A readback failure must never trigger a repost.
    const readback=await request(auth,encodeURIComponent(id)+'?fields=id,permalink');
    return {status:'published',id,creationId,
      permalink:readback.ok && typeof readback.data?.permalink==='string'?readback.data.permalink:null,
      readbackConfirmed:readback.ok && String(readback.data?.id)===id};
  }
  return {publishPost,preflight};
}
module.exports={createCalendarMetaPublisher};
