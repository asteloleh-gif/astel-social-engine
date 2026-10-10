"use strict";
const { createCalendarRepository }=require('./postgresRepository');
const { createCalendarAirtable }=require('./airtableClient');
const { createCalendarWorker }=require('./worker');
const { createCalendarMetaPublisher }=require('./metaPublisher');
const { DEFAULT_API_VERSION }=require('../../adapters/instagramAdapter');
const { errorCode }=require('./contract');
const { diagnoseInstagramPublishing }=require('./instagramAuthDiagnostics');
const { instagramPublishingAuth }=require('./instagramPublishingAuth');
const yes=x=>String(x||'').toLowerCase()==='true';

function createPublicationCalendar({ env=process.env, store, socialContext, logger=console }={}) {
  let worker=null,error=null,readiness={};
  const enabled=yes(env.CALENDAR_ENABLED);
  const brand=env.CALENDAR_BRAND||'astel.us';
  const publishers=new Map();
  function health(){return worker?{...worker.health(),lastError:worker.health().lastError||error,readiness}:{enabled,initialized:false,mode:'simulation-only',lastError:error};}
  async function probe() {
    if(!worker)return;
    for(const [key,p] of publishers)readiness[key]=await p.preflight();
    logger.log('Publication calendar read-only preflight',JSON.stringify(readiness));
    if(readiness['astel.us:instagram']?.status==='failed') {
      const source=socialContext.providers.list().find(p=>p.accountKey==='astel.us:instagram');
      const diagnostics=await diagnoseInstagramPublishing({account:source?.account,
        publishingAccessToken:env.CALENDAR_INSTAGRAM_ACCESS_TOKEN,
        apiVersion:source?.health?.().apiVersion||DEFAULT_API_VERSION});
      readiness['astel.us:instagram'].diagnostics=diagnostics;
      logger.log('Instagram publishing authorization diagnostics',JSON.stringify(diagnostics));
    }
  }
  async function start() {
    if(!enabled)return {status:'skipped',reason:'CALENDAR_DISABLED'};
    try {
      if(brand!=='astel.us' || socialContext.primaryAccount?.brand!==brand)throw new Error('CALENDAR_WRONG_BRAND');
      if(worker)return {status:'ok',reason:'ALREADY_STARTED'};
      const registry=new Map();
      for(const platform of ['threads','instagram']) {
        const source=socialContext.providers.list().find(p=>p.accountKey===`${brand}:${platform}`);
        if(!source || source.account?.username!=='astel.us')throw new Error('CALENDAR_ACCOUNT_NOT_CONFIGURED');
        const account=source.account;
        let getAuth;
        if(platform==='threads')getAuth=async()=>({status:'ok',userId:account.userId,
          token:source.tokenManager?.getToken?.()||account.accessToken,
          baseUrl:'https://graph.threads.net',apiVersion:'v1.0'});
        else {
          // Optional publication-only credential; community tokens remain unchanged.
          // Exact IG identity and quota are still checked before each mutation.
          getAuth=async()=>instagramPublishingAuth({account,
            publishingAccessToken:env.CALENDAR_INSTAGRAM_ACCESS_TOKEN,
            apiVersion:source.health?.().apiVersion||DEFAULT_API_VERSION});
        }
        const publisher=createCalendarMetaPublisher({platform,account,getAuth});
        publishers.set(account.key,publisher);
        registry.set(account.key,{account,platform,capabilities:{publishPosts:true},publishPost:publisher.publishPost,
          health:()=>({configured:!!(account.userId && account.accessToken)})});
      }
      const repository=createCalendarRepository({store,brand});
      const airtable=createCalendarAirtable({apiKey:env.AIRTABLE_API_KEY,
        baseId:env.CALENDAR_AIRTABLE_BASE_ID||env.AIRTABLE_BASE_ID,tableId:env.CALENDAR_AIRTABLE_TABLE_ID});
      worker=createCalendarWorker({repository,airtable,providers:registry,brand,
        liveEnabled:yes(env.CALENDAR_LIVE_ENABLED),intervalMs:Number(env.CALENDAR_POLL_INTERVAL_MS||60000),logger});
      const result=await worker.start();
      // Reads only; no media containers, OpenAI calls or public test posts.
      probe().catch(e=>{readiness={error:errorCode(e)};});
      return result;
    }catch(e){error=errorCode(e,'CALENDAR_INIT_FAILED');logger.error('Publication calendar startup failed',error);return {status:'error',reason:error};}
  }
  async function stop(){await worker?.stop();}
  return {start,stop,health};
}
module.exports={createPublicationCalendar};
