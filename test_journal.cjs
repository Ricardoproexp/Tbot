const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DiscordJournal}=require('./discord-journal.cjs');
const {createService}=require('./plisio.cjs');
function channel(){
 const sent=[];let next=1000;
 return {sent,send:async data=>{
  const old=sent.find(m=>m.nonce===data.nonce);if(old)return old;
  const m={id:String(next++),content:data.content,author:{id:'123'},nonce:data.nonce};sent.push(m);return m;
 },messages:{fetch:async({before,limit})=>new Map(sent.filter(m=>!before||BigInt(m.id)<BigInt(before)).slice().reverse().slice(0,limit).map(m=>[m.id,m]))}};
}
function journal(ch){return new DiscordJournal({channel:ch,authorId:'123',secret:'s'.repeat(40)});}
function service(j,mock){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'j-test-'));return createService({PLISIO_API_KEY:'test-key',PLISIO_BRIDGE_SECRET:'s'.repeat(40),PLISIO_DB_PATH:path.join(dir,'cache.sqlite'),PLISIO_PAYOUTS_ENABLED:'true',PLISIO_PUBLIC_URL:'https://example.test'},mock,j);}
const op='a'.repeat(24),address='L'+'A'.repeat(33),p={action:'payout',key:'pl-discord-test',amount:'0.1',currency:'LTC',address};
function api(send){return async(route)=>{
 if(route.startsWith('/operations/commission/'))return {fee:'0.0001',commission:'0.001'};
 if(route==='/balances/LTC')return {balance:'10'};
 if(route==='/operations/withdraw')return send();
 if(route==='/operations/'+op)return {id:op,type:'cash_out',status:'completed'};
 throw Error('unexpected_route');
};}
test('Discord replay recovers payout receipt after deleting local cache; retry never resends',async()=>{
 const ch=channel(),j=journal(ch);let calls=0;
 const mock=api(async()=>{calls++;return {id:op,type:'cash_out',status:'completed',currency:'LTC',amount:'0.1',wallet_hash:address};});
 const first=service(j,mock);await j.recover(first.restore);
 await Promise.all([first.rpc(p),first.rpc(p)]);assert.equal(calls,1);first.db.close();
 const j2=journal(ch),second=service(j2,mock);await j2.recover(second.restore);
 assert.equal((await second.rpc(p)).result.id,op);assert.equal(calls,1);
 const result=await second.rpc({action:'operation',id:op});assert.equal(result.wallet_hash,address);assert.equal(result.amount,'0.1');second.db.close();
});
test('lost provider response stays UNKNOWN after clean cache rebuild',async()=>{
 const ch=channel(),j=journal(ch);let calls=0;const mock=api(async()=>{calls++;throw Error('lost');});
 const a=service(j,mock);await a.rpc(p);a.db.close();
 const j2=journal(ch),b=service(j2,mock);await j2.recover(b.restore);
 assert.equal((await b.rpc(p)).state,'UNKNOWN');assert.equal(calls,1);b.db.close();
});
test('Discord write failure before claim prevents payment',async()=>{
 const ch=channel();ch.send=async()=>{throw Error('offline');};let calls=0;
 const a=service(journal(ch),api(async()=>{calls++;return {id:op};}));
 await assert.rejects(()=>a.rpc(p),/journal_write/);assert.equal(calls,0);a.db.close();
});
test('replay handles pagination and encrypted multi-message callbacks',async()=>{
 const ch=channel(),j=journal(ch),records=[];
 for(let n=0;n<105;n++){const e={kind:'event',n};records.push(e);await j.append(e);}
 const large={payload:crypto.randomBytes(12000).toString('hex')};records.push(large);await j.append(large);
 const rebuilt=[];await journal(ch).recover(e=>rebuilt.push(e));assert.deepEqual(rebuilt,records);
 assert(!ch.sent.some(m=>m.content.includes(large.payload)));assert(ch.sent.every(m=>m.content.length<=2000));
});
test('missing journal segment and wrong secret fail closed',async()=>{
 const ch=channel(),j=journal(ch);for(let n=0;n<3;n++)await j.append({n});
 const wrong=new DiscordJournal({channel:ch,authorId:'123',secret:'wrong-secret'});
 await assert.rejects(()=>wrong.recover(()=>{}));
 ch.sent.splice(1,1);await assert.rejects(()=>journal(ch).recover(()=>{}),/missing/);
});
test('verified invoice callback survives cache loss',async()=>{
 const ch=channel(),j=journal(ch);
 const mock=async route=>route==='/invoices/new'?{txn_id:op,invoice_url:'https://plisio.net/invoice/'+op}:{id:op,type:'invoice',status:'completed'};
 const a=service(j,mock);await a.rpc({action:'invoice',key:'pl-invoice-journal',amount:'0.1'});
 const event={txn_id:op,ipn_type:'invoice',order_number:'pl-invoice-journal',currency:'LTC',amount:'0.1',status:'completed'};
 event.verify_hash=crypto.createHmac('sha1','test-key').update(JSON.stringify(event)).digest('hex');
 await a.recordEvent(event);a.db.close();
 const j2=journal(ch),b=service(j2,mock);await j2.recover(b.restore);
 assert.equal((await b.rpc({action:'operation',id:op})).evidence_source,'signed_callback');b.db.close();
});
