"use strict";
const { TERMINAL } = require("./contract");
const TABLE = "astel_calendar_jobs_v1";

function createCalendarRepository({ store, brand = "astel.us" } = {}) {
  if (!store?.query || !store?.transaction) throw new Error("CALENDAR_DATABASE_REQUIRED");
  let initialized = false;
  const scope = `${brand}:`;
  const sql = async (q, p = []) => store.query(q, p);
  const read = row => row ? ({ id: row.id, accountKey: row.account_key, recordId: row.record_id,
    status: row.status, content: row.content, scheduledAt: new Date(row.scheduled_at).toISOString(),
    metadata: row.metadata, result: row.result || {}, errorCode: row.error_code,
    hash: row.review_hash, mode: row.delivery_mode, reviewer: row.reviewer,
    dirty: row.dirty, syncVersion: Number(row.sync_version), createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString() }) : null;

  async function init() {
    if (!store.isReady()) throw new Error("CALENDAR_DATABASE_UNAVAILABLE");
    await sql(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id text PRIMARY KEY, account_key text NOT NULL, record_id text NOT NULL,
      review_hash text NOT NULL, delivery_mode text NOT NULL CHECK (delivery_mode IN ('Simulation','Live')),
      content jsonb NOT NULL, scheduled_at timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('DRAFT','PENDING','PROCESSING','SIMULATED','PUBLISHED','FAILED','AMBIGUOUS_HOLD','CANCELLED')),
      metadata jsonb NOT NULL DEFAULT '{}', result jsonb NOT NULL DEFAULT '{}',
      reviewer text, error_code text, claim_token text, lease_until timestamptz,
      dirty boolean NOT NULL DEFAULT true, sync_version bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql(`CREATE INDEX IF NOT EXISTS astel_calendar_due_v1 ON ${TABLE}(status, scheduled_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS astel_calendar_record_v1 ON ${TABLE}(record_id)`);
    initialized = true;
    return true;
  }
  function allowed(accountKey) {
    if (![`${brand}:threads`, `${brand}:instagram`].includes(accountKey)) throw new Error("CALENDAR_ACCOUNT_NOT_ALLOWED");
  }
  async function get(id) { return read((await sql(`SELECT * FROM ${TABLE} WHERE id=$1 AND account_key LIKE $2`, [id, scope+'%'])).rows[0]); }
  async function stage(candidate) {
    allowed(candidate.accountKey);
    return store.transaction(async tx => {
      // Serialize all versions of one editor row; a second review cannot replace in-flight work.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`astel-calendar:${candidate.recordId}`]);
      const inflight = await tx.query(`SELECT id FROM ${TABLE} WHERE record_id=$1 AND status='PROCESSING'`, [candidate.recordId]);
      if (inflight.rows.length) throw new Error("RECORD_ALREADY_PROCESSING");
      await tx.query(`UPDATE ${TABLE} SET sync_version=sync_version+1,status='CANCELLED', updated_at=now(), dirty=false
        WHERE record_id=$1 AND id<>$2 AND status IN ('DRAFT','PENDING')`, [candidate.recordId, candidate.id]);
      await tx.query(`INSERT INTO ${TABLE}(id,account_key,record_id,review_hash,delivery_mode,content,scheduled_at,status,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8) ON CONFLICT(id) DO NOTHING`,
        [candidate.id,candidate.accountKey,candidate.recordId,candidate.hash,candidate.mode,
          JSON.stringify(candidate.content),candidate.scheduledAt,
          JSON.stringify({ deliveryMode:candidate.mode, recordId:candidate.recordId, reviewHash:candidate.hash, revision:candidate.revision })]);
      return read((await tx.query(`SELECT * FROM ${TABLE} WHERE id=$1`,[candidate.id])).rows[0]);
    });
  }
  async function approve(id, hash, reviewer) {
    if (!String(reviewer || '').trim()) throw new Error("REVIEWER_REQUIRED");
    const r = await sql(`UPDATE ${TABLE} SET sync_version=sync_version+1,status='PENDING',reviewer=$3,updated_at=now(),dirty=true
      WHERE id=$1 AND review_hash=$2 AND status='DRAFT' AND account_key LIKE $4 RETURNING id`, [id,hash,reviewer,scope+'%']);
    return r.rowCount === 1;
  }
  async function due(now = new Date(), limit=5) {
    return (await sql(`SELECT id FROM ${TABLE} WHERE status='PENDING' AND scheduled_at<=$1
      AND account_key LIKE $2 ORDER BY scheduled_at,id LIMIT $3`, [now,scope+'%',Math.max(1,Math.min(25,limit))])).rows.map(r=>r.id);
  }
  async function claim(id, token, { now=new Date(), leaseMs=720000 }={}) {
    const r=await sql(`UPDATE ${TABLE} SET sync_version=sync_version+1,status='PROCESSING',claim_token=$2,lease_until=$3,updated_at=$4,dirty=true
      WHERE id=$1 AND status='PENDING' AND scheduled_at<=$4 AND account_key LIKE $5 RETURNING id`,
      [id,token,new Date(new Date(now).getTime()+leaseMs),now,scope+'%']);
    return r.rowCount===1;
  }
  async function verifyLease(id, token, now=new Date()) {
    return (await sql(`SELECT id FROM ${TABLE} WHERE id=$1 AND claim_token=$2 AND status='PROCESSING'
      AND lease_until>$3 AND account_key LIKE $4`,[id,token,now,scope+'%'])).rows.length===1;
  }
  async function checkpoint(id, token, patch) {
    const r=await sql(`UPDATE ${TABLE} SET sync_version=sync_version+1,result=result || $3::jsonb,updated_at=now(),dirty=true
      WHERE id=$1 AND claim_token=$2 AND status='PROCESSING' AND lease_until>now() RETURNING id`,[id,token,JSON.stringify(patch)]);
    if(r.rowCount!==1) throw new Error("CALENDAR_LEASE_LOST");
    return true;
  }
  async function finish(id, token, status, {result={},errorCode=null,now=new Date()}={}) {
    if(!TERMINAL.has(status)) throw new Error("INVALID_CALENDAR_TERMINAL_STATUS");
    const r=await sql(`UPDATE ${TABLE} SET sync_version=sync_version+1,status=$3,result=result || $4::jsonb,error_code=$5,
      updated_at=$6,claim_token=null,lease_until=null,dirty=true WHERE id=$1 AND claim_token=$2
      AND status='PROCESSING' AND lease_until>$6 RETURNING id`,[id,token,status,JSON.stringify(result),errorCode,now]);
    return r.rowCount===1;
  }
  async function recoverExpired(now=new Date()) {
    const r=await sql(`UPDATE ${TABLE} SET sync_version=sync_version+1,status='AMBIGUOUS_HOLD',error_code='WORKER_LEASE_EXPIRED',
      claim_token=null,lease_until=null,updated_at=$1,dirty=true WHERE status='PROCESSING'
      AND lease_until<=$1 AND account_key LIKE $2`,[now,scope+'%']);
    return r.rowCount;
  }
  async function cancelRecord(recordId) {
    await sql(`UPDATE ${TABLE} SET sync_version=sync_version+1,status='CANCELLED',updated_at=now(),dirty=true
      WHERE record_id=$1 AND status IN ('DRAFT','PENDING') AND account_key LIKE $2`,[recordId,scope+'%']);
  }
  async function dirtyJobs(limit=50) {
    return (await sql(`SELECT * FROM ${TABLE} WHERE dirty=true AND account_key LIKE $1
      ORDER BY updated_at,id LIMIT $2`,[scope+'%',limit])).rows.map(read);
  }
  async function markSynced(id, syncVersion) {
    await sql(`UPDATE ${TABLE} SET dirty=false WHERE id=$1 AND sync_version=$2`,[id,syncVersion]);
  }
  async function counts() {
    return Object.fromEntries((await sql(`SELECT status,count(*)::int AS n FROM ${TABLE}
      WHERE account_key LIKE $1 GROUP BY status`,[scope+'%'])).rows.map(r=>[r.status,r.n]));
  }
  return { init, get, stage, approve, due, claim, verifyLease, checkpoint, finish, recoverExpired,
    cancelRecord, dirtyJobs, markSynced, counts, isReady:()=>initialized && store.isReady(),
    health:()=>({connected:initialized && store.isReady(),backend:'postgres',brand}), quit:async()=>{} };
}
module.exports={createCalendarRepository};
