const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createService,signatureValid,authValid}=require('./plisio.cjs');
const address='L'+'A'.repeat(33), op='a'.repeat(24);
function setup(mock){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plisio-test-'));const env={PLISIO_API_KEY:'test-key',PLISIO_BRIDGE_SECRET:'s'.repeat(40),PLISIO_DB_PATH:path.join(dir,'jobs.db'),PLISIO_PERSISTENT_STORAGE_CONFIRMED:'yes',PLISIO_PAYOUTS_ENABLED:'true',PLISIO_PUBLIC_URL:'https://example.test'};return {env,svc:createService(env,mock),dir};}
function provider(send){return async (p,v)=>{if(p.startsWith('/operations/commission/'))return {fee:'0.000010000000',commission:'0.0005'};if(p==='/balances/LTC')return {balance:'10'};if(p==='/operations/withdraw')return send(v);throw Error('Unexpected endpoint');};}
const payload={action:'payout',key:'pl-test-000001',currency:'LTC',address,amount:'0.1'};
test('valid and modified webhook JSON signatures',()=>{const d={txn_id:op,ipn_type:'invoice',status:'completed',amount:'0.1'};d.verify_hash=crypto.createHmac('sha1','key').update(JSON.stringify(d)).digest('hex');assert(signatureValid(d,'key'));assert(!signatureValid({...d,amount:'1'},'key'));});
test('signed bridge requests reject alteration and stale timestamps',()=>{const raw=Buffer.from('{"action":"rate"}'),t=String(Math.floor(Date.now()/1000)),s='s'.repeat(40);const h=crypto.createHmac('sha256',s).update(t+'.').update(raw).digest('hex');assert(authValid(raw,t,h,s));assert(!authValid(Buffer.from('{}'),t,h,s));assert(!authValid(raw,t,h,s,Date.now()+130000));});
test('parallel payout retries send once; durable result survives restart',async()=>{let sent=0;const mock=provider(async()=>{sent++;await new Promise(r=>setTimeout(r,10));return {id:op,status:'completed'};});const {svc,env}=setup(mock);await Promise.all([svc.rpc(payload),svc.rpc(payload)]);assert.equal(sent,1);svc.db.close();const next=createService(env,mock);assert.equal((await next.rpc(payload)).result.id,op);assert.equal(sent,1);next.db.close();});
test('provider timeout remains UNKNOWN after restart and is never resent',async()=>{let sent=0;const mock=provider(async()=>{sent++;throw Error('response lost');});const {svc,env}=setup(mock);assert.equal((await svc.rpc(payload)).state,'UNKNOWN');svc.db.close();const next=createService(env,mock);assert.equal((await next.rpc(payload)).state,'UNKNOWN');assert.equal(sent,1);next.db.close();});
test('persisted SUBMITTING from crash cannot send again',async()=>{let sent=0;const {svc}=setup(provider(async()=>{sent++;return {};}));const p={amount:payload.amount,currency:'LTC',address};svc.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,NULL,?)').run(payload.key,'payout',JSON.stringify(p),JSON.stringify(p),'SUBMITTING',Date.now());assert.equal((await svc.rpc(payload)).state,'SUBMITTING');assert.equal(sent,0);svc.db.close();});
test('changed destination on same key rejected',async()=>{const {svc}=setup(provider(async()=>({id:op})));await svc.rpc(payload);await assert.rejects(()=>svc.rpc({...payload,address:'M'+'B'.repeat(33)}),/idempotency_conflict/);svc.db.close();});
test('payout disabled and excessive amount do not send',async()=>{let sent=0;const {svc,env}=setup(provider(async()=>{sent++;return {id:op};}));env.PLISIO_PAYOUTS_ENABLED='false';await assert.rejects(()=>svc.rpc(payload),/disabled/);await assert.rejects(()=>svc.rpc({...payload,amount:'2'}),/limit/);assert.equal(sent,0);svc.db.close();});
test('invoice recovery uses original order and return_existing',async()=>{let n=0;const {svc}=setup(async(p,v)=>{assert.equal(p,'/invoices/new');assert.equal(v.order_number,'pl-invoice-001');assert.equal(v.return_existing,1);assert(v.callback_url.endsWith('json=true'));n++;if(n===1)throw Error('lost');return {txn_id:op,invoice_url:'https://plisio.net/invoice/'+op};});const p={action:'invoice',key:'pl-invoice-001',amount:'0.1'};await assert.rejects(()=>svc.rpc(p));assert.equal((await svc.rpc(p)).result.txn_id,op);assert.equal((await svc.rpc(p)).result.txn_id,op);assert.equal(n,2);svc.db.close();});
test('reconciliation rejects wrong amount and prevents reusing an operation',async()=>{
 let amount='0.2';
 const base=provider(async()=>{throw Error('lost');});
 const {svc}=setup(async(p,v)=>p==='/operations/'+op?{id:op,type:'cash_out',status:'completed',psys_cid:'LTC',wallet_hash:address,amount}:base(p,v));
 await svc.rpc(payload);
 await assert.rejects(()=>svc.rpc({action:'reconcile',key:payload.key,id:op}),/mismatch/);
 amount='0.1';assert.equal((await svc.rpc({action:'reconcile',key:payload.key,id:op})).state,'DONE');
 const other={...payload,key:'pl-test-000002'};await svc.rpc(other);
 await assert.rejects(()=>svc.rpc({action:'reconcile',key:other.key,id:op}),/already_linked/);
 svc.db.close();
});
test('HTTP callback authenticates before forwarding and acknowledges delivery failures',async()=>{
 const {createApp}=require('./index');
 const {svc,env}=setup(async()=>{});svc.db.close();env.PLISIO_ENABLED='true';
 let ready=true;const sent=[];
 const app=createApp({env,sendDiscord:async x=>sent.push(x),isReady:()=>ready});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port+'/webhooks/plisio?json=true';
 const p={txn_id:op,ipn_type:'invoice',amount:'0.1',status:'completed'};
 p.verify_hash=crypto.createHmac('sha1',env.PLISIO_API_KEY).update(JSON.stringify(p)).digest('hex');
 const post=p=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
 try {
 assert.equal((await post({...p,amount:'2'})).status,401);assert.equal(sent.length,0);
 assert.equal((await post(p)).status,200);assert.match(sent[0],/^PLISIO:[a-f0-9]{24}:[a-f0-9]{64}$/);
 ready=false;assert.equal((await post(p)).status,503);
 const rpc=await fetch(url.replace('/webhooks/plisio?json=true','/plisio/rpc'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"rate"}'});
 assert.equal(rpc.status,401);
 } finally {await new Promise(r=>server.close(r));}
});
function signedEvent(svc,event){
 const data={...event};data.verify_hash=crypto.createHmac('sha1','test-key').update(JSON.stringify(data)).digest('hex');
 const hash=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
 svc.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)').run(hash,JSON.stringify(data),Date.now());return data;
}
async function invoiceFixture(){
 let details={id:op,type:'invoice',status:'completed'};
 const {svc,env}=setup(async p=>p==='/invoices/new'?{txn_id:op,invoice_url:'https://plisio.net/invoice/'+op}:details);
 await svc.rpc({action:'invoice',key:'pl-invoice-001',amount:'0.1'});
 return {svc,env,setDetails:v=>details=v,event:{txn_id:op,ipn_type:'invoice',order_number:'pl-invoice-001',status:'completed',currency:'LTC',amount:'0.1'}};
}
test('non-White-Label deposit requires signed matching callback and survives restart',async()=>{
 const {svc,env,event}=await invoiceFixture();
 await assert.rejects(()=>svc.rpc({action:'operation',id:op}),/awaiting_verified/);
 signedEvent(svc,event);svc.db.close();
 const next=createService(env,async()=>({id:op,type:'invoice',status:'completed'}));
 const r=await next.rpc({action:'operation',id:op});assert.equal(r.amount,'0.1');assert.equal(r.currency,'LTC');assert.equal(r.evidence_source,'signed_callback');
 next.db.close();
});
test('callback from another order, bad currency, short payment or forged signature cannot credit',async()=>{
 for(const change of [{order_number:'other-order'}, {currency:'BTC'}, {amount:'0.01'}, {txn_id:'b'.repeat(24)}]){
  const {svc,event}=await invoiceFixture();signedEvent(svc,{...event,...change});
  await assert.rejects(()=>svc.rpc({action:'operation',id:op}));svc.db.close();
 }
 const {svc,event}=await invoiceFixture();const e={...event,verify_hash:'0'.repeat(40)};
 svc.db.prepare('INSERT INTO events VALUES(?,?,?)').run('forged',JSON.stringify(e),Date.now());
 await assert.rejects(()=>svc.rpc({action:'operation',id:op}),/awaiting_verified/);svc.db.close();
});
test('signed completion does not override current pending or conflicting amount',async()=>{
 const {svc,event,setDetails}=await invoiceFixture();signedEvent(svc,event);
 setDetails({id:op,type:'invoice',status:'pending'});
 assert.equal((await svc.rpc({action:'operation',id:op})).status,'pending');
 setDetails({id:op,type:'invoice',status:'completed',amount:'0.2'});
 await assert.rejects(()=>svc.rpc({action:'operation',id:op}),/conflict/);svc.db.close();
});
test('non-White-Label payout uses durable provider receipt, never the requested amount alone',async()=>{
 const receipt={id:op,type:'cash_out',status:'pending',currency:'LTC',amount:'0.1',wallet_hash:address};
 let current={id:op,type:'cash_out',status:'completed'};let sends=0;
 const base=provider(async()=>{sends++;return receipt;});
 const mock=async(p,v)=>p==='/operations/'+op?current:base(p,v);
 const {svc,env}=setup(mock);await svc.rpc(payload);svc.db.close();
 const next=createService(env,mock);
 const r=await next.rpc({action:'operation',id:op});assert.equal(r.wallet_hash,address);assert.equal(r.amount,'0.1');assert.equal(r.status,'completed');
 assert.equal(r.evidence_source,'withdrawal_receipt');
 current={...current,amount:'0.2'};await assert.rejects(()=>next.rpc({action:'operation',id:op}),/conflict/);
 assert.equal(sends,1);next.db.close();
 const bad=setup(async(p,v)=>p==='/operations/'+op?{id:op,type:'cash_out',status:'completed'}:provider(async()=>({id:op,status:'completed'}))(p,v));
 await bad.svc.rpc(payload);await assert.rejects(()=>bad.svc.rpc({action:'operation',id:op}),/evidence_unavailable/);bad.svc.db.close();
});
test('minimal production config uses disposable cache and no mounted volume',()=>{
 const {environment}=require('./config.cjs');
 const e={TBOT_TOKEN:'token',TIMEWALL:'secret',PLISIO_API_KEY:'key',PLISIO_BRIDGE_SECRET:'s'.repeat(40),PLISIO_PUBLIC_URL:'https://example.test'};
 const actual=environment(e);assert.equal(actual.PORT,'3001');assert(actual.PLISIO_DB_PATH.startsWith(os.tmpdir()));
 assert.equal(actual.PLISIO_STORAGE_MODE,'discord');
 assert.throws(()=>environment({...e,PLISIO_PUBLIC_URL:'http://bad.test'}),/HTTPS/);
 assert.throws(()=>environment({...e,PLISIO_API_KEY:''}),/Missing/);
});
