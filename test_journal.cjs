'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DiscordJournal}=require('./discord-journal.cjs');
const {createService}=require('./faucetpay.cjs');
function channel(){
 const sent=[];let next=1000;
 return {sent,send:async data=>{const old=sent.find(m=>m.nonce===data.nonce);if(old)return old;const m={id:String(next++),content:data.content,author:{id:'123'},nonce:data.nonce};sent.push(m);return m;},
 messages:{fetch:async({before,limit})=>new Map(sent.filter(m=>!before||BigInt(m.id)<BigInt(before)).slice().reverse().slice(0,limit).map(m=>[m.id,m]))}};
}
function journal(ch){return new DiscordJournal({channel:ch,authorId:'123',secret:'s'.repeat(40)});}
function env(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fp-journal-'));return {FAUCETPAY_SEND_KEY:'send-test',FAUCETPAY_READ_KEY:'read-test',FAUCETPAY_BRIDGE_SECRET:'s'.repeat(40),FAUCETPAY_DB_PATH:path.join(dir,'cache.sqlite'),FAUCETPAY_PERSISTENT_STORAGE_CONFIRMED:'yes'};}
function mock(send){return async(route,body)=>{if(route==='/check-address')return {payout_user_hash:'hash'};if(route==='/balance')return {balance:'999999999'};if(route==='/send')return send(body);throw Error('unexpected_endpoint');};}
const req={action:'payout',key:'withdraw-journal-001',currency:'LTC',amount:'0.1',address:'fpuser@example.com'};
test('Discord journal recovers FaucetPay payout receipt after cache loss without resending',async()=>{
 const ch=channel(),j=journal(ch),e=env();let sends=0;
 const api=mock(async body=>{sends++;assert.equal(body.idempotency_key,req.key);return {payout_id:'payout-777'};});
 const first=createService(e,api,j);await j.recover(first.restore);const a=await first.rpc(req);assert.equal(a.state,'DONE');first.db.close();
 const j2=journal(ch),e2=env(),second=createService(e2,api,j2);await j2.recover(second.restore);assert.equal((await second.rpc(req)).result.payout_id,'payout-777');assert.equal(sends,1);second.db.close();
});
test('uncertain FaucetPay payout remains UNKNOWN after cache rebuild and is not retried',async()=>{
 const ch=channel(),j=journal(ch),e=env();let sends=0;const api=mock(async()=>{sends++;throw Error('response lost');});
 const a=createService(e,api,j);await j.recover(a.restore);await assert.rejects(()=>a.rpc(req),/payout_outcome_uncertain/);assert.equal((await a.rpc({action:'job',key:req.key})).state,'UNKNOWN');a.db.close();
 const j2=journal(ch),b=createService(env(),api,j2);await j2.recover(b.restore);assert.equal((await b.rpc(req)).state,'UNKNOWN');assert.equal(sends,1);b.db.close();
});
test('Discord journal write failure before payout claim prevents provider send',async()=>{
 const ch=channel();ch.send=async()=>{throw Error('offline');};let sends=0;const svc=createService(env(),mock(async()=>{sends++;return {payout_id:'p'};}),journal(ch));
 await assert.rejects(()=>svc.rpc(req),/journal_write/);assert.equal(sends,0);svc.db.close();
});
test('journal replay handles pagination and encrypted large records',async()=>{
 const ch=channel(),j=journal(ch),records=[];for(let n=0;n<105;n++){const e={kind:'event',n};records.push(e);await j.append(e);}const large={payload:crypto.randomBytes(12000).toString('hex')};records.push(large);await j.append(large);
 const rebuilt=[];await journal(ch).recover(e=>rebuilt.push(e));assert.deepEqual(rebuilt,records);assert(!ch.sent.some(m=>m.content.includes(large.payload)));assert(ch.sent.every(m=>m.content.length<=2000));
});
test('missing journal segment and wrong secret fail closed',async()=>{
 const ch=channel(),j=journal(ch);for(let n=0;n<3;n++)await j.append({n});
 const wrong=new DiscordJournal({channel:ch,authorId:'123',secret:'wrong-secret'});await assert.rejects(()=>wrong.recover(()=>{}));
 ch.sent.splice(1,1);await assert.rejects(()=>journal(ch).recover(()=>{}),/missing/);
});
