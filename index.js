'use strict';
const express = require('express');
const crypto = require('node:crypto');

function scalar(value, max = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function numberInput(value) {
  return scalar(value, 80) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
}
function constantToken(a, b) {
  if (!a || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

function createApp({ env = process.env, sendDiscord, isReady, botId = () => null, service }) {
  const app = express();
  app.disable('x-powered-by');
  const channelId = env.DISCORD_CHANNEL_ID || '1559371192400613450';
  app.get('/', (_req, res) => res.status(200).send('Tbot — TimeWall / Plisio relay online'));
  app.get('/health', (_req, res) => res.status(isReady() ? 200 : 503).json({
    status: isReady() ? 'online' : 'starting',
    discord: isReady() ? 'connected' : 'disconnected',
    discord_bot_id: botId(), discord_channel: channelId,
    timewall: env.TIMEWALL ? 'configured' : 'not configured',
    plisio: env.PLISIO_ENABLED === 'true' ? 'enabled' : 'disabled',
  }));

  // Preserve the original TimeWall URL, SHA-256 formula and CREDIT/CHARGEBACK format.
  app.get('/timewall-postback', async (req, res) => {
    const q = req.query;
    const userID = q.userid || q.userID || q.userId;
    const transactionID = q.transactionid || q.transactionID || q.transactionId;
    const revenue = q.revenue;
    const currencyAmount = q.currencyAmount;
    const hash = q.hash;
    const type = q.type;
    const withdrawalId = q.withdrawid;
    if (!scalar(userID) || !/^(?:Telegram_)?[1-9]\d{0,15}$/.test(userID) ||
        !scalar(transactionID, 160) || !scalar(withdrawalId, 160) || !/^[A-Za-z0-9_.-]+$/.test(withdrawalId) ||
        !scalar(hash, 64) || !scalar(type, 40) || !numberInput(revenue) || !numberInput(currencyAmount)) {
      return res.status(400).send('Missing or invalid parameters');
    }
    if (!env.TIMEWALL) return res.status(503).send('TimeWall not configured');
    const uid = userID.replace(/^Telegram_/, '');
    const quantity = Number(currencyAmount);
    if (!Number.isSafeInteger(Number(uid)) || Number(uid) >= 2 ** 52 || quantity === 0 || Math.abs(quantity) > 1e9 ||
        Math.abs(Number(quantity.toFixed(5)) - quantity) > 1e-12) {
      return res.status(400).send('Invalid user or amount');
    }
    const expected = crypto.createHash('sha256').update(userID + parseFloat(revenue) + env.TIMEWALL).digest();
    const received = /^[a-f0-9]{64}$/i.test(hash) ? Buffer.from(hash, 'hex') : null;
    if (!received || !crypto.timingSafeEqual(received, expected)) return res.status(403).send('Invalid hash');
    const kind = type.toLowerCase() === 'chargeback' ? 'CHARGEBACK' : 'CREDIT';
    if (kind === 'CREDIT' && quantity < 0) return res.status(400).send('Invalid credit amount');
    const decimal = quantity.toFixed(5).replace(/\.?0+$/, '');
    if (!isReady()) return res.status(503).send('Discord unavailable');
    try {
      await sendDiscord(`${kind}:${uid}:${decimal}:${withdrawalId}`);
      return res.status(200).send('1');
    } catch {
      return res.status(503).send('Discord delivery failed; retry');
    }
  });

  require('./plisio.cjs').install(app, {env, sendDiscord, isReady, service});

  app.get('/test-postback', async (req, res) => {
    if (!constantToken(env.TEST_TOKEN, req.get('x-test-token'))) return res.status(403).send('Forbidden');
    if (!isReady()) return res.status(503).send('Discord unavailable');
    try {
      await sendDiscord(`TEST:${Date.now()}:1.50`);
      return res.status(200).send('Test sent; no balance is credited');
    } catch {
      return res.status(503).send('Discord delivery failed');
    }
  });
  app.use((err, _req, res, _next) => {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'body_too_large' : 'invalid_request' });
  });
  return app;
}

async function main() {
  const env = require('./config.cjs').environment();
  const { Client, GatewayIntentBits } = require('discord.js');
  const token = env.TBOT_TOKEN;
  if (!token || (!env.TIMEWALL && env.PLISIO_ENABLED !== 'true')) {
    throw new Error('Configure TBOT_TOKEN and TIMEWALL and/or PLISIO_ENABLED=true');
  }
  const channelId = env.DISCORD_CHANNEL_ID || '1559371192400613450';
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid DISCORD_CHANNEL_ID');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  let journal, recovered=false;
  const service=require('./plisio.cjs').createService(env,undefined,{
    append: entry=>{
      if(!recovered || !journal || journal.broken) throw Error('discord_recovering');
      return journal.append(entry);
    },
  });
  const app = createApp({
    env,service,
    isReady: () => client.isReady() && recovered && !journal.broken, botId: () => client.user?.id || null,
    sendDiscord: async content => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || typeof channel.send !== 'function') throw new Error('Unavailable channel');
      await channel.send({ content, allowedMentions: { parse: [] } });
    },
  });
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = app.listen(port, '0.0.0.0', () => console.log(`HTTP ready on ${port}`));
  client.once('ready', async () => {
    try {
      const channel=await client.channels.fetch(channelId);
      const {PermissionFlagsBits}=require('discord.js');
      if(!channel?.messages || !channel.permissionsFor(client.user)?.has([
          PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages]))
        throw Error('Grant View Channel, Read Message History and Send Messages to the Discord bot');
      journal=new (require('./discord-journal.cjs').DiscordJournal)({channel,authorId:client.user.id,secret:env.PLISIO_BRIDGE_SECRET});
      console.log('Recovering Plisio records from Discord history...');
      await journal.recover(service.restore);
      recovered=true;
      console.log(`Discord ready; relay author ID: ${client.user.id}; recovered ${journal.seq} records`);
    } catch {console.error('Discord history recovery failed. Check channel permissions, secret and journal integrity. Payments remain blocked.');}
  });
  client.on('error', () => console.error('Discord connection error'));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await client.destroy();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await client.login(token); } catch { await stop(); throw new Error('Discord login failed'); }
}
module.exports = { createApp };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
