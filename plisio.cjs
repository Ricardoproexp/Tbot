'use strict';
// Node 24. All financial state must live on a persistent mounted volume.
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const ID = /^[a-f0-9]{24}$/i;
const COINS={LTC:8,BTC:8,SOL:9};
const LIMITS={LTC:'1',BTC:'0.001',SOL:'1'};
function coinId(value) {
  // Plisio lists SOL as the ID and Solana as its display currency code.
  return value==='Solana'?'SOL':value;
}
function supported(value) {
  if(!Object.hasOwn(COINS,value)) throw Error('unsupported_currency');
  return value;
}
function units(s,currency='LTC') {
  const precision=COINS[supported(currency)];
  if(typeof s!=='string' || !/^\d{1,10}(?:\.\d+)?$/.test(s)) throw Error('invalid_amount');
  const [a,b='']=s.split('.');
  if(b.length>precision) throw Error('invalid_precision');
  return BigInt(a)*10n**BigInt(precision)+BigInt(b.padEnd(precision,'0'));
}
function addressValid(currency,address) {
  if(typeof address!=='string') return false;
  const base58='[1-9A-HJ-NP-Za-km-z]';
  if(currency==='SOL') {
    if(!new RegExp('^'+base58+'{32,44}$').test(address)) return false;
    const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value=0n;for(const c of address)value=value*58n+BigInt(alphabet.indexOf(c));
    let bytes=0;while(value){bytes++;value>>=8n;}
    return bytes+(address.match(/^1*/)[0].length)===32;
  }
  const prefix=currency==='BTC'?'[13]':'[LM3]';
  const hrp=currency==='BTC'?'bc1':'ltc1';
  return new RegExp('^'+prefix+base58+'{25,34}$').test(address) ||
    (address===address.toLowerCase() || address===address.toUpperCase()) &&
    new RegExp('^'+hrp+'[ac-hj-np-z02-9]{11,87}$','i').test(address);
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
function createService(env, apiOverride, journal) {
  if (!env.PLISIO_API_KEY || (env.PLISIO_BRIDGE_SECRET || '').length<32) throw Error('Configure Plisio secrets');
  if (!env.PLISIO_DB_PATH || !path.isAbsolute(env.PLISIO_DB_PATH)) throw Error('PLISIO_DB_PATH must be absolute on persistent volume');
  if (!journal && env.PLISIO_PERSISTENT_STORAGE_CONFIRMED !== 'yes') throw Error('Confirm persistent volume before enabling Plisio');
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
    supported(p.currency);
    if(!addressValid(p.currency,p.address)) throw Error('invalid_wallet_address');
    const n=units(p.amount,p.currency); if(n<=0n || n>units(env['PLISIO_MAX_PAYOUT_'+p.currency] || LIMITS[p.currency],p.currency)) throw Error('payout_limit');
  }
  async function preflight(p) {
    validatePayment(p);
    const fees=await api('/operations/commission/'+p.currency,{addresses:p.address,amounts:p.amount,type:'cash_out',feePlan:'normal'});
    const f=String(fees.fee), c=String(fees.commission);
    // Provider may return >8 decimal places in fee estimates; round UP.
    const precision=COINS[p.currency];
    const ceil=s=>{if(!/^\d+(?:\.\d+)?$/.test(s)) throw Error('invalid_fee'); const [a,b='']=s.split('.');return units(a+'.'+b.slice(0,precision).padEnd(precision,'0'),p.currency)+( /[1-9]/.test(b.slice(precision))?1n:0n);};
    const bal=await api('/balances/'+p.currency);
    if(units(String(bal.balance),p.currency) < units(p.amount,p.currency)+ceil(f)+ceil(c)) throw Error('insufficient_provider_balance');
    return {fee:f,commission:c,currency:p.currency};
  }
  function saveResult(key,result,state='DONE') {
    db.prepare('UPDATE jobs SET result=?,state=? WHERE key=?').run(JSON.stringify(result),state,key);
  }
  function linked(key,id) {
    db.prepare('INSERT OR IGNORE INTO links(operation,job) VALUES(?,?)').run(id,key);
    const row=db.prepare('SELECT job FROM links WHERE operation=?').get(id);
    if(!row || row.job!==key) throw Error('operation_already_linked');
  }
  function restore(e) {
    if(e.kind==='claim') {
      if(!['invoice','payout'].includes(e.action)) throw Error('invalid_journal_claim');
      db.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?, 'SUBMITTING',NULL,?)").run(e.key,e.action,e.fingerprint,JSON.stringify(e.payload),e.created);
    } else if(e.kind==='result') {
      if(!record(e.key)) throw Error('journal_missing_claim');
      if(e.id) linked(e.key,e.id);
      saveResult(e.key,e.result,e.state);
    } else if(e.kind==='event') {
      db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)').run(e.digest,JSON.stringify(e.payload),e.created);
    } else throw Error('invalid_journal_record');
  }
  let tail=Promise.resolve();
  function serial(fn) {const run=tail.then(fn);tail=run.catch(()=>{});return run;}
  async function write(entry) {
    if(journal) await journal.append(entry);
    restore(entry);
  }
  function recordEvent(payload) {return serial(async()=>{
    const digest=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if(!db.prepare('SELECT 1 FROM events WHERE id=?').get(digest))
      await write({kind:'event',digest,payload,created:Date.now()});
    return digest;
  });}
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
    const currency=coinId(evidence.psys_cid || evidence.currency);
    if(currency!==expected.currency || (evidence.psys_cid && evidence.currency && coinId(evidence.psys_cid)!==coinId(evidence.currency))) throw Error('operation_currency_mismatch');
    const amount=String(evidence.amount);
    if(type==='invoice' ? units(amount,currency)<units(expected.amount,currency) : units(amount,currency)!==units(expected.amount,currency)) throw Error('operation_amount_mismatch');
    if(type==='cash_out' && evidence.wallet_hash!==expected.address) throw Error('operation_address_mismatch');
    // Never allow an old receipt to conceal conflicting fields in a current API response.
    if(remote.amount!=null && units(String(remote.amount),currency)!==units(amount,currency)) throw Error('operation_amount_conflict');
    for(const k of ['psys_cid','currency']) if(remote[k]!=null && coinId(remote[k])!==currency) throw Error('operation_currency_conflict');
    if(type==='cash_out' && remote.wallet_hash!=null && remote.wallet_hash!==evidence.wallet_hash) throw Error('operation_address_conflict');
    return {...remote, currency, psys_cid:currency, amount,
      ...(type==='cash_out'?{wallet_hash:evidence.wallet_hash}:{}),
      evidence_source:evidence===remote?'operation':type==='invoice'?'signed_callback':'withdrawal_receipt'};
  }
  async function rpc(p) {
    if(!p || typeof p!=='object') throw Error('invalid_request');
    if(p.action==='rate') {
      const rows=await api('/currencies/USD');
      const currency=supported(p.currency || 'LTC');
      const ltc=Array.isArray(rows) && rows.find(x=>x.cid===currency);
      if(!ltc || ltc.maintenance===true || ltc.maintenance==='true' || ltc.maintenance===1 || ltc.maintenance==='1' || (ltc.hidden!=null && Number(ltc.hidden)!==0) || !Number.isFinite(Number(ltc.price_usd)) || !(Number(ltc.price_usd)>0)) throw Error('currency_unavailable');
      return {currency,precision:COINS[currency],price_usd:String(ltc.price_usd),min_sum_in:String(ltc.min_sum_in)};
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
      if(r.id!==p.id || r.type!=='cash_out' || r.status!=='completed' || coinId(r.psys_cid || r.currency)!==expected.currency || (r.psys_cid && r.currency && coinId(r.psys_cid)!==coinId(r.currency)) || r.wallet_hash!==expected.address || units(String(r.amount),expected.currency)!==units(expected.amount,expected.currency)) throw Error('reconciliation_mismatch');
      await write({kind:'result',key:p.key,id:p.id,result:r,state:'DONE'}); return {state:'DONE',result:r};
    }
    if(!['invoice','payout'].includes(p.action) || !/^[a-z0-9-]{8,80}$/.test(p.key || '')) throw Error('invalid_action_or_key');
    let payload;
    if(p.action==='invoice') {
      if(units(p.amount)<=0n || units(p.amount)>units(env.PLISIO_MAX_DEPOSIT_LTC || '10')) throw Error('deposit_limit');
      const base=new URL(env.PLISIO_PUBLIC_URL); if(base.protocol!=='https:') throw Error('https_required');
      payload={amount:p.amount,currency:'LTC'};
    } else {validatePayment(p); payload={amount:p.amount,currency:p.currency,address:p.address};}
    const fingerprint=JSON.stringify(payload), old=record(p.key);
    if(old) {
      if(old.kind!==p.action || old.fingerprint!==fingerprint) throw Error('idempotency_conflict');
      if(old.state==='DONE' || p.action==='payout') return {state:old.state,result:old.result};
    }
    if(p.action==='payout') {
      if(env.PLISIO_PAYOUTS_ENABLED!=='true') throw Error('payouts_disabled');
      await preflight(payload);
      await write({kind:'claim',key:p.key,action:p.action,payload,fingerprint,created:Date.now()});
      try {
        const r=await api('/operations/withdraw',{currency:p.currency,type:'cash_out',to:p.address,amount:p.amount});
        if(!ID.test(r.id || '')) throw Error('missing_payout_id');
        await write({kind:'result',key:p.key,id:r.id,result:r,state:'DONE'}); return {state:'DONE',result:r};
      } catch {await write({kind:'result',key:p.key,result:null,state:'UNKNOWN'}); return {state:'UNKNOWN',result:null};}
    }
    await write({kind:'claim',key:p.key,action:p.action,payload,fingerprint,created:Date.now()});
    const callback=new URL('/webhooks/plisio',env.PLISIO_PUBLIC_URL);callback.searchParams.set('json','true');
    try {
      const r=await api('/invoices/new',{currency:'LTC',allowed_psys_cids:'LTC',amount:p.amount,order_number:p.key,order_name:'Deposito Tbot',expire_min:30,return_existing:1,callback_url:callback.href});
      if(!ID.test(r.txn_id || '') || !/^https:\/\/plisio\.net\/invoice\//.test(r.invoice_url || '')) throw Error('bad_invoice');
      await write({kind:'result',key:p.key,id:r.txn_id,result:r,state:'DONE'}); return {state:'DONE',result:r};
    } catch {await write({kind:'result',key:p.key,result:null,state:'UNKNOWN'});throw Error('invoice_creation_uncertain_retry_same_order');}
  }
  return {rpc:p=>serial(()=>rpc(p)),restore,recordEvent,db,api,signatureValid:data=>signatureValid(data,env.PLISIO_API_KEY)};
}
function install(app,{env,sendDiscord,isReady,service}) {
  if(env.PLISIO_ENABLED!=='true') return;
  const express=require('express'), svc=service || createService(env);
  app.post('/plisio/rpc',express.raw({type:'application/json',limit:'16kb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body) || !authValid(req.body,req.get('x-tbot-time'),req.get('x-tbot-signature'),env.PLISIO_BRIDGE_SECRET)) return res.status(401).json({error:'unauthorized'});
    if(!isReady()) return res.status(503).json({ok:false,error:'discord_recovering'});
    try {res.json({ok:true,data:await svc.rpc(JSON.parse(req.body))});}
    catch(e) {res.status(400).json({ok:false,error:/^[a-z0-9_]+$/.test(e.message)?e.message:'request_failed'});}
  });
  app.post('/webhooks/plisio',express.json({limit:'64kb'}),async(req,res)=>{
    if(!svc.signatureValid(req.body)) return res.status(401).json({error:'invalid_signature'});
    const p=req.body; if(!ID.test(p.txn_id || '') || p.ipn_type!=='invoice') return res.status(400).json({error:'invalid_invoice'});
    if(!isReady()) return res.status(503).json({error:'discord_recovering'});
    let digest;
    try {digest=await svc.recordEvent(p);} catch {return res.status(503).json({error:'journal_unavailable'});}
    // Persist verified evidence before notifying. Termux polls even if Discord is unavailable.
    if(!isReady()) return res.status(503).json({error:'discord_unavailable'});
    try {await sendDiscord(`PLISIO:${p.txn_id}:${digest}`);res.json({ok:true});}
    catch {res.status(503).json({error:'delivery_failed'});}
  });
}
module.exports={createService,install,signatureValid,authValid,units};
