"use strict";
const { parseRecord, choice, TERMINAL, errorCode } = require("./contract");
const { createPublishEngine } = require("../publishing/publishEngine");

function createCalendarWorker({ repository, airtable, providers, liveEnabled=false, brand='astel.us',
  now=()=>new Date(), intervalMs=60000, maxLatenessMs=3600000,
  setIntervalImpl=setInterval, clearIntervalImpl=clearInterval, logger=console }={}) {
  let timer=null, running=false, initialized=false, lastCycleAt=null, lastError=null, stats=null, counts={};
  const actualInterval=Math.max(15000,Number(intervalMs)||60000);
  async function verifyApproval(job) {
    const row=await airtable.get(job.recordId);
    const candidate=parseRecord(row,{brand});
    if(candidate.hash!==job.hash || candidate.reviewHash!==job.hash || choice(row.fields['Job ID'])!==job.id) throw new Error('CONTENT_CHANGED_REAPPROVAL_REQUIRED');
    if(candidate.approval!=='Approved')throw new Error('APPROVAL_WITHDRAWN');
    if(!candidate.reviewer || candidate.reviewer!==job.reviewer)throw new Error('REVIEWER_REQUIRED_OR_CHANGED');
    if(job.mode==='Live' && !liveEnabled)throw new Error('LIVE_RELEASE_NOT_ENABLED');
    if(now().getTime()-new Date(job.scheduledAt).getTime()>maxLatenessMs)throw new Error('MISSED_SCHEDULE_REVIEW_REQUIRED');
    return true;
  }
  const engine=createPublishEngine({providerRegistry:{findForAccount:key=>providers.get(key)},repository,
    enabled:true,dryRun:!liveEnabled,leaseMs:720000,batchSize:3,now,
    beforeProcess:verifyApproval,
    beforeMutation:async(job,token)=>{
      if(!await repository.verifyLease(job.id,token,now()))throw new Error('CALENDAR_LEASE_LOST');
      await verifyApproval(job);
    }});
  const stamp=()=>now().toISOString();
  function resultFields(job) {
    return {'Job ID':job.id,'Review Hash':job.hash,Result:job.status==='DRAFT'?'AWAITING_APPROVAL':job.status==='PENDING'?'SCHEDULED':job.status,
      'Published ID':job.result?.id||'', 'Published URL':job.result?.permalink||'',
      Error:job.errorCode||'', 'Last Checked':stamp()};
  }
  async function processRecord(row) {
    const action=choice(row.fields?.Approval);
    if(action==='Cancelled') {
      await repository.cancelRecord(row.id);
      const job=await repository.get(choice(row.fields?.['Job ID']));
      if(job?.status==='PROCESSING') {
        await airtable.patch(row.id,{Result:'CANCELLATION_REQUESTED', 'Last Checked':stamp()});
      } else {
        await airtable.patch(row.id,{...(job?resultFields(job):{Result:'CANCELLED','Last Checked':stamp()}),Approval:'Draft'});
      }
      return;
    }
    if(!['Request review','Approved'].includes(action))return;
    try {
      const candidate=parseRecord(row,{brand});
      if(action==='Request review') {
        const job=await repository.stage(candidate);
        await airtable.patch(row.id,{...resultFields(job),Approval:'Draft'});
        await repository.markSynced(job.id,job.syncVersion);
        return;
      }
      const job=await repository.get(candidate.id);
      if(!job || job.hash!==candidate.reviewHash || choice(row.fields['Job ID'])!==candidate.id)throw new Error('CONTENT_CHANGED_REAPPROVAL_REQUIRED');
      if(!candidate.reviewer)throw new Error('REVIEWER_REQUIRED');
      if(candidate.mode==='Live' && !liveEnabled) {
        await airtable.patch(row.id,{Result:'BLOCKED_LIVE_RELEASE',Error:'Live release is not enabled. No post will be sent.','Last Checked':stamp()});
        return;
      }
      if(job.status==='DRAFT')await repository.approve(candidate.id,candidate.hash,candidate.reviewer);
      else if(TERMINAL.has(job.status))await airtable.patch(row.id,resultFields(job));
    }catch(e){
      const reason=errorCode(e);
      await repository.cancelRecord(row.id);
      await airtable.patch(row.id,{Result:'REAPPROVAL_REQUIRED',Error:reason,Approval:'Draft','Last Checked':stamp()});
    }
  }
  async function writeback() {
    for(const job of await repository.dirtyJobs(50)) {
      const row=await airtable.get(job.recordId);
      // Never let a historical job overwrite the row's newer reviewed revision.
      if(choice(row.fields?.['Job ID'])===job.id)await airtable.patch(job.recordId,resultFields(job));
      await repository.markSynced(job.id,job.syncVersion);
    }
  }
  async function runOnce() {
    if(running)return {status:'skipped',reason:'CALENDAR_BUSY'};
    if(!initialized)return {status:'skipped',reason:'CALENDAR_NOT_INITIALIZED'};
    running=true;lastCycleAt=stamp();lastError=null;
    try {
      const records=await airtable.list();
      // Without a successful current editor read nothing enters the publish engine.
      for(const row of records)await processRecord(row);
      const result=await engine.tick();
      if(result.status==='error')throw new Error('CALENDAR_ENGINE_ERROR');
      await writeback();
      counts=await repository.counts();
      stats={status:'ok',records:records.length,processed:result.processed||0,recoveredToHold:result.recoveredToHold||0,
        results:(result.results||[]).map(x=>({id:x.id,status:x.status,reason:x.reason||null}))};
      if(records.length || stats.processed || stats.recoveredToHold)logger.log('Publication calendar cycle',JSON.stringify(stats));
      return stats;
    }catch(e){lastError=errorCode(e);stats={status:'error',reason:lastError};logger.error('Publication calendar error',lastError);return stats;}
    finally{running=false;}
  }
  async function init() {await repository.init();initialized=true;return {status:'ok'};}
  async function start() {
    if(!initialized)await init();
    if(timer)return {status:'ok',reason:'ALREADY_STARTED'};
    timer=setIntervalImpl(()=>{runOnce().catch(()=>{lastError='CALENDAR_UNHANDLED_ERROR';});},actualInterval);
    timer?.unref?.();
    await runOnce();
    return {status:lastError?'error':'ok',reason:lastError||'STARTED'};
  }
  async function stop(){if(timer)clearIntervalImpl(timer);timer=null;}
  function health(){return {enabled:true,initialized,running:!!timer,cycleActive:running,mode:liveEnabled?'approval-gated-live':'simulation-only',
    intervalMs:actualInterval,timezone:'America/Chicago',repository:repository.health(),lastCycleAt,lastError,stats,counts};}
  return {init,start,stop,runOnce,health,engine,verifyApproval};
}
module.exports={createCalendarWorker};
