"use strict";
const fetch = require("node-fetch");
const ACTIVE = "OR({Approval}='Request review',{Approval}='Cancelled',AND({Approval}='Approved',NOT(OR({Result}='SIMULATED',{Result}='PUBLISHED',{Result}='FAILED',{Result}='AMBIGUOUS_HOLD',{Result}='CANCELLED'))))";
function createCalendarAirtable({ apiKey, baseId, tableId, fetchImpl=fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms)) }={}) {
  if(!apiKey || !/^app[A-Za-z0-9]{14}$/.test(baseId||'') || !/^tbl[A-Za-z0-9]{14}$/.test(tableId||'')) throw new Error("CALENDAR_AIRTABLE_CONFIG_MISSING");
  const root=`https://api.airtable.com/v0/${baseId}/${tableId}`;
  let lastAt=0;
  async function request(suffix='',{method='GET',body}={}) {
    const wait=260-(Date.now()-lastAt); if(wait>0) await sleep(wait);
    lastAt=Date.now();
    let res;
    try { res=await fetchImpl(root+suffix,{method,timeout:15000,redirect:'error',headers:{
      Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); }
    catch(_){throw new Error("CALENDAR_AIRTABLE_NETWORK_ERROR");}
    const data=await res.json().catch(()=>null);
    if(!res.ok || !data) throw new Error(`CALENDAR_AIRTABLE_HTTP_${res.status}`);
    return data;
  }
  async function list() {
    const records=[]; let offset=null;
    for(let page=0;page<5;page++) {
      const q=new URLSearchParams({filterByFormula:ACTIVE,pageSize:'100'});
      if(offset)q.set('offset',offset);
      const d=await request('?'+q);
      records.push(...(d.records||[])); offset=d.offset;
      if(!offset)return records;
    }
    throw new Error("CALENDAR_PAGE_LIMIT_EXCEEDED");
  }
  async function get(id) {
    if(!/^rec[A-Za-z0-9]{14}$/.test(id||''))throw new Error("INVALID_RECORD_ID");
    return request('/'+id);
  }
  async function patch(id,fields) {
    if(!/^rec[A-Za-z0-9]{14}$/.test(id||''))throw new Error("INVALID_RECORD_ID");
    return request('/'+id,{method:'PATCH',body:{fields,typecast:false}});
  }
  return {list,get,patch};
}
module.exports={createCalendarAirtable};
