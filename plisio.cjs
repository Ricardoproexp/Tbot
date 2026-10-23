'use strict';
// Node 24. All financial state must live on a persistent mounted volume.
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const ID = /^[a-f0-9]{24}$/i;
function units(s) {
  if (typeof s !== 'string' || !/^\d{1,10}(?:\.\d{1,8})?$/.test(s)) throw Error('invalid_amount');
  const [a,b=''] = s.split('.'); return BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'));
}
function signatureValid(data, key) {
  if (!data || !/^[a-f0-9]{40}$/i.test(data.verify_hash || '')) return false;
  const ordered = {...data}; delete ordered.verify_hash;
  const expected = crypto.createHmac('sha1', key).update(JSON.stringify(ordered)).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(data.verify_hash,'hex'));
}
function authValid(raw, timestamp, sig, secret, now=Date.now()) {
  if (!secret || !/^\d{10}$/.test(timestamp || '') || Math.abs(now/1000-Number(timestamp))>120 || !/^[a-f0-9]{64}$/.test(sig || '')) return false;
  const h = crypto.createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
  return crypto.timingSafeEqual(h,Buffer.from(sig,'hex'));
}
function createService(env, apiOverride) {
  if (!env.PLISIO_API_KEY || (env.PLISIO_BRIDGE_SECRET || '').length<32) throw Error('Configure Plisio secrets');
  if (!env.PLISIO_DB_PATH || !path.isAbsolute(env.PLISIO_DB_PATH)) throw Error('PLISIO_DB_PATH must be absolute on persistent volume');
  if (env.PLISIO_PERSISTENT_STORAGE_CONFIRMED !== 'yes') throw Error('Confirm persistent volume before enabling Plisio');
  fs.mkdirSync(path.dirname(env.PLISIO_DB_PATH),{recursive:true,mode:0o700});
  const db = new DatabaseSync(env.PLISIO_DB_PATH);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS links (operation TEXT PRIMARY KEY, job TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_invoice ON events(json_extract(payload,'$.txn_id'),json_extract(payload,'$.status'));`);
  const api = apiOverride || (async (endpoint, params={}) => {
    const u = new URL('https://api.plisio.net/api/v1'+endpoint);
    for (const [k,v] of Object.entries({...params,api_key:env.PLISIO_API_KEY})) u.searchParams.set(k,String(v));
    try {
      const r=await fetch(u,{signal:AbortSignal.timeout(25000),redirect:'error'});
      const body=await r.text(); if(body.length>1024*1024) throw Error();
      const j=JSON.parse(body);
      if(!r.ok || j.status!=='success' || !j.data || typeof j.data!=='object') throw Error();
      return j.data;
    } catch { throw Error('plisio_request_failed_or_uncertain'); }
  });
  function record(key) {const r=db.prepare('SELECT * FROM jobs WHERE key=?').get(key); return r ? {...r,result:r.result?JSON.parse(r.result):null}:null;}
  function validatePayment(p) {
    if(p.currency!=='LTC' || typeof p.address!=='string' || !/^[A-Za-z0-9]{26,100}$/.test(p.address)) throw Error('invalid_ltc_address');
    const n=units(p.amount); if(n<=0n || n>units(env.PLISIO_MAX_PAYOUT_LTC || '1')) throw Error('payout_limit');
  }
  async function preflight(p) {
    validatePayment(p);
    const fees=await api('/operations/commission/LTC',{addresses:p.address,amounts:p.amount,type:'cash_out',feePlan:'normal'});
    const f=String(fees.fee), c=String(fees.commission);
    // Provider may return >8 decimal places in fee estimates; round UP.
    const ceil=s=>{if(!/^\d+(?:\.\d+)?$/.test(s)) throw Error('invalid_fee'); const [a,b='']=s.split('.');return units(a+'.'+b.slice(0,8).padEnd(8,'0'))+( /[1-9]/.test(b.slice(8))?1n:0n);};
    const bal=await api('/balances/LTC');
    if(units(String(bal.balance)) < units(p.amount)+ceil(f)+ceil(c)) throw Error('insufficient_provider_balance');
    return {fee:f,commission:c,currency:'LTC'};
  }
  function saveResult(key,result,state='DONE') {
    db.prepare('UPDATE jobs SET result=?,state=? WHERE key=?').run(JSON.stringify(result),state,key);
  }
  function linked(key,id) {
    db.prepare('INSERT OR IGNORE INTO links(operation,job) VALUES(?,?)').run(id,key);
    const row=db.prepare('SELECT job FROM links WHERE operation=?').get(id);
    if(!row || row.job!==key) throw Error('operation_already_linked');
  }
  // Only provider-authenticated evidence may supply fields omitted without White Label.
  function verifiedOperation(id, remote) {
    const link=db.prepare('SELECT job FROM links WHERE operation=?').get(id);
    const job=link && record(link.job);
    if(!job) throw Error('untracked_operation');
    const expected=JSON.parse(job.payload);
    const type=job.kind==='invoice'?'invoice':'cash_out';
    if(remote.type!==type) throw Error('operation_type_mismatch');
    let evidence=remote;
    const missing = remote.amount==null || !(remote.psys_cid || remote.currency) ||
      (type==='cash_out' && !remote.wallet_hash);
    if(missing && type==='invoice') {
      const rows=db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.txn_id')=? AND json_extract(payload,'$.status')='completed' ORDER BY created DESC").all(id);
      evidence=rows.map(r=>JSON.parse(r.payload)).find(e=>
        signatureValid(e,env.PLISIO_API_KEY) && e.ipn_type==='invoice' &&
        String(e.order_number)===job.key && e.txn_id===id);
      if(!evidence) throw Error('awaiting_verified_invoice_callback');
    } else if(missing) {
      evidence=job.result;
      if(!evidence || evidence.id!==id || evidence.type!=='cash_out')
        throw Error('payout_evidence_unavailable_manual_review');
    }
    const currency=evidence.psys_cid || evidence.currency;
    if(currency!==expected.currency || (evidence.psys_cid && evidence.currency && evidence.psys_cid!==evidence.currency)) throw Error('operation_currency_mismatch');
    const amount=String(evidence.amount);
    if(type==='invoice' ? units(amount)<units(expected.amount) : units(amount)!==units(expected.amount)) throw Error('operation_amount_mismatch');
    if(type==='cash_out' && evidence.wallet_hash!==expected.address) throw Error('operation_address_mismatch');
    // Never allow an old receipt to conceal conflicting fields in a current API response.
    if(remote.amount!=null && units(String(remote.amount))!==units(amount)) throw Error('operation_amount_conflict');
    for(const k of ['psys_cid','currency']) if(remote[k]!=null && remote[k]!==currency) throw Error('operation_currency_conflict');
    if(type==='cash_out' && remote.wallet_hash!=null && remote.wallet_hash!==evidence.wallet_hash) throw Error('operation_address_conflict');
    return {...remote, currency, psys_cid:currency, amount,
      ...(type==='cash_out'?{wallet_hash:evidence.wallet_hash}:{}),
      evidence_source:evidence===remote?'operation':type==='invoice'?'signed_callback':'withdrawal_receipt'};
  }
  async function rpc(p) {
    if(!p || typeof p!=='object') throw Error('invalid_request');
    if(p.action==='rate') {
      const rows=await api('/currencies/USD');
      const ltc=Array.isArray(rows) && rows.find(x=>x.cid==='LTC');
      if(!ltc || ltc.maintenance || !(Number(ltc.price_usd)>0)) throw Error('ltc_unavailable');
      return {price_usd:String(ltc.price_usd),min_sum_in:String(ltc.min_sum_in)};
    }
    if(p.action==='quote') return preflight(p);
    if(p.action==='operation') {
      if(!ID.test(p.id || '')) throw Error('invalid_id');
      const remote=await api('/operations/'+p.id);
      if(String(remote.id)!==p.id) throw Error('operation_id_mismatch');
      return verifiedOperation(p.id, remote);
    }
    if(p.action==='job') {
      const j=record(p.key); if(!j) return {state:'NOT_FOUND'};
      return {state:j.state,result:j.result};
    }
    if(p.action==='reconcile') {
      const j=record(p.key);
      if(!j || j.kind!=='payout' || !ID.test(p.id || '')) throw Error('invalid_reconciliation');
      const expected=JSON.parse(j.payload), r=await api('/operations/'+p.id);
      if(r.id!==p.id || r.type!=='cash_out' || r.status!=='completed' || (r.psys_cid || r.currency)!=='LTC' || r.wallet_hash!==expected.address || units(String(r.amount))!==units(expected.amount)) throw Error('reconciliation_mismatch');
      linked(p.key,p.id); saveResult(p.key,r); return {state:'DONE',result:r};
    }
    if(!['invoice','payout'].includes(p.action) || !/^[a-z0-9-]{8,80}$/.test(p.key || '')) throw Error('invalid_action_or_key');
    let payload;
    if(p.action==='invoice') {
      if(units(p.amount)<=0n || units(p.amount)>units(env.PLISIO_MAX_DEPOSIT_LTC || '10')) throw Error('deposit_limit');
      const base=new URL(env.PLISIO_PUBLIC_URL); if(base.protocol!=='https:') throw Error('https_required');
      payload={amount:p.amount,currency:'LTC'};
    } else {validatePayment(p); payload={amount:p.amount,currency:'LTC',address:p.address};}
    const fingerprint=JSON.stringify(payload), old=record(p.key);
    if(old) {
      if(old.kind!==p.action || old.fingerprint!==fingerprint) throw Error('idempotency_conflict');
      if(old.state==='DONE' || p.action==='payout') return {state:old.state,result:old.result};
    }
    if(p.action==='payout') {
      if(env.PLISIO_PAYOUTS_ENABLED!=='true') throw Error('payouts_disabled');
      await preflight(payload);
      // No await between claim and the first provider request. Only one process may claim.
      const claim=db.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?, 'SUBMITTING',NULL,?)").run(p.key,p.action,fingerprint,JSON.stringify(payload),Date.now());
      if(!claim.changes) {const j=record(p.key);return {state:j.state,result:j.result};}
      try {
        const r=await api('/operations/withdraw',{currency:'LTC',type:'cash_out',to:p.address,amount:p.amount});
        if(!ID.test(r.id || '')) throw Error('missing_payout_id');
        linked(p.key,r.id); saveResult(p.key,r); return {state:'DONE',result:r};
      } catch {saveResult(p.key,null,'UNKNOWN'); return {state:'UNKNOWN',result:null};}
    }
    db.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?, 'SUBMITTING',NULL,?)").run(p.key,p.action,fingerprint,JSON.stringify(payload),Date.now());
    const callback=new URL('/webhooks/plisio',env.PLISIO_PUBLIC_URL);callback.searchParams.set('json','true');
    try {
      const r=await api('/invoices/new',{currency:'LTC',allowed_psys_cids:'LTC',amount:p.amount,order_number:p.key,order_name:'Deposito Tbot',expire_min:30,return_existing:1,callback_url:callback.href});
      if(!ID.test(r.txn_id || '') || !/^https:\/\/plisio\.net\/invoice\//.test(r.invoice_url || '')) throw Error('bad_invoice');
      linked(p.key,r.txn_id); saveResult(p.key,r); return {state:'DONE',result:r};
    } catch {saveResult(p.key,null,'UNKNOWN');throw Error('invoice_creation_uncertain_retry_same_order');}
  }
  return {rpc,db,api,signatureValid:data=>signatureValid(data,env.PLISIO_API_KEY)};
}
function install(app,{env,sendDiscord,isReady}) {
  if(env.PLISIO_ENABLED!=='true') return;
  const express=require('express'), svc=createService(env);
  app.post('/plisio/rpc',express.raw({type:'application/json',limit:'16kb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body) || !authValid(req.body,req.get('x-tbot-time'),req.get('x-tbot-signature'),env.PLISIO_BRIDGE_SECRET)) return res.status(401).json({error:'unauthorized'});
    try {res.json({ok:true,data:await svc.rpc(JSON.parse(req.body))});}
    catch(e) {res.status(400).json({ok:false,error:/^[a-z0-9_]+$/.test(e.message)?e.message:'request_failed'});}
  });
  app.post('/webhooks/plisio',express.json({limit:'64kb'}),async(req,res)=>{
    if(!svc.signatureValid(req.body)) return res.status(401).json({error:'invalid_signature'});
    const p=req.body; if(!ID.test(p.txn_id || '') || p.ipn_type!=='invoice') return res.status(400).json({error:'invalid_invoice'});
    const digest=crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
    svc.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)').run(digest,JSON.stringify(p),Date.now());
    // Persist verified evidence before notifying. Termux polls even if Discord is unavailable.
    if(!isReady()) return res.status(503).json({error:'discord_unavailable'});
    try {await sendDiscord(`PLISIO:${p.txn_id}:${digest}`);res.json({ok:true});}
    catch {res.status(503).json({error:'delivery_failed'});}
  });
}
module.exports={createService,install,signatureValid,authValid,units};
