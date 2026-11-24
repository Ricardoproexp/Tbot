const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createApp}=require('./index');

test('TimeWall credit, chargeback, validation and delivery failures',async()=>{
 const env={TIMEWALL:'test-timewall-only',TEST_TOKEN:'test-only'};
 let ready=true,fail=false;const sent=[];
 const app=createApp({env,isReady:()=>ready,sendDiscord:async m=>{if(fail)throw Error('simulated');sent.push(m);}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const q=new URLSearchParams({userid:'Telegram_42',revenue:'1.00',currencyAmount:'0.70',type:'credit',transactionid:'tx1',withdrawid:'withdraw1'});
 const sign=()=>q.set('hash',crypto.createHash('sha256').update('Telegram_42'+1+env.TIMEWALL).digest('hex'));
 const post=()=>fetch(base+'/timewall-postback?'+q);
 try {
  sign();let r=await post();assert.equal(r.status,200);assert.equal(await r.text(),'1');assert.equal(sent.at(-1),'CREDIT:42:0.7:withdraw1');
  q.set('type','chargeback');q.set('currencyAmount','-0.70');assert.equal((await post()).status,200);assert.equal(sent.at(-1),'CHARGEBACK:42:-0.7:withdraw1');
  q.set('type','credit');assert.equal((await post()).status,400);
  q.set('currencyAmount','0.7garbage');assert.equal((await post()).status,400);
  q.set('currencyAmount','0.7');q.set('hash','0'.repeat(64));assert.equal((await post()).status,403);sign();
  let count=sent.length;ready=false;assert.equal((await post()).status,503);assert.equal(sent.length,count);ready=true;
  fail=true;assert.equal((await post()).status,503);assert.equal(sent.length,count);fail=false;
  assert.equal((await fetch(base+'/test-postback')).status,403);
  assert.equal((await fetch(base+'/test-postback',{headers:{'x-test-token':env.TEST_TOKEN}})).status,200);assert.match(sent.at(-1),/^TEST:/);
  let health=await fetch(base+'/health');assert.equal(health.status,200);health=await health.json();assert.equal(health.timewall,'configured');assert.equal(health.faucetpay,'disabled');
  ready=false;assert.equal((await fetch(base+'/health')).status,503);
 } finally {await new Promise(r=>server.close(r));}
});

test('TimeWall-only configuration starts without FaucetPay credentials or database',()=>{
 assert.doesNotThrow(()=>createApp({env:{TIMEWALL:'test'},sendDiscord:async()=>{},isReady:()=>true}));
});

test('FaucetPay webhook verifies raw HMAC and relays payout.failed only',async()=>{
 const secret='whsec-test-'.repeat(4),env={FAUCETPAY_ENABLED:'true',FAUCETPAY_WEBHOOK_SECRET:secret};
 const events=[],sent=[];const service={recordEvent:async e=>{events.push(e);return {duplicate:false};}};
 const app=createApp({env,isReady:()=>true,sendDiscord:async x=>sent.push(x),service});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const payload={id:'event-12345678',event:'payout.failed',created_at:1,data:{payout_id:'pay_123456',to:'user@example.com',currency:'LTC',amount:100}};
 const raw=Buffer.from(JSON.stringify(payload)),sig='sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');
 try{
  let r=await fetch(base+'/webhooks/faucetpay',{method:'POST',headers:{'content-type':'application/json','x-faucetpay-signature':'sha256='+'0'.repeat(64)},body:raw});assert.equal(r.status,401);
  r=await fetch(base+'/webhooks/faucetpay',{method:'POST',headers:{'content-type':'application/json','x-faucetpay-signature':sig},body:raw});assert.equal(r.status,200);
  assert.equal(events.length,1);assert.match(sent[0],/^FAUCETPAY_FAILED:/);const relay=JSON.parse(Buffer.from(sent[0].split(':')[1],'base64url').toString());assert.deepEqual(relay,{event_id:'event-12345678',payout_id:'pay_123456',currency:'LTC',amount_units:'100',recipient:'user@example.com'});
  const sentBefore=sent.length;payload.event='payout.sent';const raw2=Buffer.from(JSON.stringify(payload)),sig2='sha256='+crypto.createHmac('sha256',secret).update(raw2).digest('hex');
  r=await fetch(base+'/webhooks/faucetpay',{method:'POST',headers:{'content-type':'application/json','x-faucetpay-signature':sig2},body:raw2});assert.equal(r.status,200);assert.equal(sent.length,sentBefore);
 }finally{await new Promise(r=>server.close(r));}
});
