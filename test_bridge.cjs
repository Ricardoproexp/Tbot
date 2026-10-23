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
  let health=await fetch(base+'/health');assert.equal(health.status,200);health=await health.json();assert.equal(health.timewall,'configured');assert.equal(health.plisio,'disabled');
  ready=false;assert.equal((await fetch(base+'/health')).status,503);
 } finally {await new Promise(r=>server.close(r));}
});

test('TimeWall-only configuration starts without Plisio credentials or database',()=>{
 assert.doesNotThrow(()=>createApp({env:{TIMEWALL:'test'},sendDiscord:async()=>{},isReady:()=>true}));
});
