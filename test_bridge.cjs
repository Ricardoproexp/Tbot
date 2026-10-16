const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp, sortDeep } = require('./index');

test('TimeWall and NOWPayments relay, authentication and delivery failures', async () => {
  const env = { TIMEWALL: 'test-timewall-only', NOWPAYMENTS_IPN_SECRET: 'test-ipn-only', TEST_TOKEN: 'test-only' };
  let ready = true, fail = false;
  const sent = [];
  const app = createApp({ env, isReady: () => ready, sendDiscord: async message => {
    if (fail) throw new Error('simulated failure'); sent.push(message);
  }});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const event = { id: '123', batch_withdrawal_id: '456', status: 'FINISHED', currency: 'ltc', address: 'private-address', amount: '0.1', fee: null };
    const signature = payload => crypto.createHmac('sha512', env.NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sortDeep(payload))).digest('hex');
    const post = (payload, sig = signature(payload)) => fetch(base + '/webhooks/nowpayments', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig }, body: JSON.stringify(payload) });
    assert.equal((await post(event, '0'.repeat(128))).status, 401);
    assert.equal(sent.length, 0);
    assert.equal((await post(event)).status, 200);
    assert.match(sent[0], /^NOWPAYMENTS:123:[a-f0-9]{64}$/);
    assert.ok(!sent[0].includes('private-address'));
    assert.equal((await post(event)).status, 200);
    assert.equal(sent[0], sent[1]); // deterministic key for persistent Termux deduplication
    assert.equal((await post({ payment_id: 123, payment_status: 'finished' })).status, 200);
    assert.equal(sent.length, 2);
    ready = false; assert.equal((await post(event)).status, 503); ready = true;
    fail = true; assert.equal((await post(event)).status, 503); fail = false;
    const q = new URLSearchParams({ userid: 'Telegram_42', revenue: '1.00', currencyAmount: '0.70', type: 'credit', transactionid: 'tx1', withdrawid: 'withdraw1' });
    q.set('hash', crypto.createHash('sha256').update('Telegram_42' + 1 + env.TIMEWALL).digest('hex'));
    let r = await fetch(base + '/timewall-postback?' + q); assert.equal(r.status, 200); assert.equal(await r.text(), '1');
    assert.equal(sent.at(-1), 'CREDIT:42:0.7:withdraw1');
    q.set('type', 'chargeback'); q.set('currencyAmount', '-0.70');
    assert.equal((await fetch(base + '/timewall-postback?' + q)).status, 200);
    assert.equal(sent.at(-1), 'CHARGEBACK:42:-0.7:withdraw1');
    q.set('currencyAmount', '0.7garbage'); assert.equal((await fetch(base + '/timewall-postback?' + q)).status, 400);
    q.set('currencyAmount', '0.7'); q.set('hash', '0'.repeat(64)); assert.equal((await fetch(base + '/timewall-postback?' + q)).status, 403);
    assert.equal((await fetch(base + '/test-postback')).status, 403);
    assert.equal((await fetch(base + '/test-postback', { headers: { 'x-test-token': env.TEST_TOKEN } })).status, 200);
    assert.match(sent.at(-1), /^TEST:/);
    assert.equal((await fetch(base + '/webhooks/nowpayments', {method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
    assert.equal((await post({...event, extra:'x'.repeat(70000)})).status,413);
    assert.equal((await fetch(base + '/health')).status,200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
