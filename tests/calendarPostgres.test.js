"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {createCalendarRepository}=require('../app/calendar/postgresRepository');
const {parseRecord}=require('../app/calendar/contract');

test('calendar PostgreSQL: durable review/claim/concurrency/lease/restart/writeback integration',
 {skip:!process.env.CALENDAR_TEST_DATABASE_URL},async()=>{
 const u=new URL(process.env.CALENDAR_TEST_DATABASE_URL);
 assert.ok(['127.0.0.1','localhost'].includes(u.hostname),'test may only connect to local disposable CI PostgreSQL');
 assert.equal(u.pathname,'/calendar_test');
 const pool=new Pool({connectionString:u.toString()});
 const store={query:(...x)=>pool.query(...x),isReady:()=>true,transaction:async fn=>{
 const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
 try {
 const a=createCalendarRepository({store});await a.init();
 const c=parseRecord({id:'recPGintegration1',fields:{Platform:'Threads',Format:'Text',Caption:'PG integration test','Scheduled At':new Date().toISOString(),'Delivery Mode':'Simulation',Revision:1}});
 await pool.query('DELETE FROM astel_calendar_jobs_v1 WHERE record_id=$1',[c.recordId]);
 await a.stage(c);assert.equal((await a.get(c.id)).status,'DRAFT');await a.approve(c.id,c.hash,'ci-only-operator');
 const now=new Date();const claims=await Promise.all([a.claim(c.id,'worker-a',{now,leaseMs:60000}),a.claim(c.id,'worker-b',{now,leaseMs:60000})]);
 assert.equal(claims.filter(Boolean).length,1);const token=claims[0]?'worker-a':'worker-b';
 assert.equal(await a.verifyLease(c.id,token,new Date()),true);await a.checkpoint(c.id,token,{creationId:'fake-container'});
 assert.equal(await a.finish(c.id,'wrong','SIMULATED'),false);
 assert.equal(await a.finish(c.id,token,'SIMULATED',{result:{wouldPublish:true}}),true);
 const b=createCalendarRepository({store});await b.init();const saved=await b.get(c.id);assert.equal(saved.status,'SIMULATED');assert.equal(saved.result.creationId,'fake-container');
 await b.markSynced(saved.id,saved.syncVersion);assert.equal((await b.get(c.id)).dirty,false);
 // Terminal review replay never resets the completed job to pending.
 assert.equal((await b.stage(c)).status,'SIMULATED');assert.equal(await b.approve(c.id,c.hash,'ci'),false);
 const next={...c,id:c.id+'-lease',hash:c.hash+'1',revision:2};await b.stage(next);await b.approve(next.id,next.hash,'ci');
 await b.claim(next.id,'lease',{now:new Date(Date.now()+1000),leaseMs:1000});
 assert.equal(await b.recoverExpired(new Date(Date.now()+5000)),1);assert.equal((await b.get(next.id)).status,'AMBIGUOUS_HOLD');
 assert.equal(await b.claim(next.id,'retry',{now:new Date(Date.now()+6000),leaseMs:1000}),false);
 }finally {await pool.end();}
});
