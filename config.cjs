
'use strict';
const fs=require('node:fs');
const config=Object.freeze({
  port:3001,
  discordChannelId:'1559371192400613450',
  databasePath:'/data/plisio.sqlite',
  maxPayoutLtc:'1',
  maxDepositLtc:'10',
  payoutsEnabled:true,
});
function environment(secrets=process.env, mountInfo=fs.readFileSync('/proc/self/mountinfo','utf8')) {
  for(const key of ['TBOT_TOKEN','TIMEWALL','PLISIO_API_KEY','PLISIO_BRIDGE_SECRET','PLISIO_PUBLIC_URL'])
    if(!secrets[key]) throw Error('Missing '+key);
  const url=new URL(secrets.PLISIO_PUBLIC_URL);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/')
    throw Error('PLISIO_PUBLIC_URL must be an HTTPS origin without a path');
  if(!mountInfo.split('\n').some(line=>line.split(' ')[4]==='/data'))
    throw Error('Mount a persistent volume at /data before starting. Do not store payment records in the container filesystem.');
  return {
    TBOT_TOKEN:secrets.TBOT_TOKEN,TIMEWALL:secrets.TIMEWALL,
    PLISIO_API_KEY:secrets.PLISIO_API_KEY,PLISIO_BRIDGE_SECRET:secrets.PLISIO_BRIDGE_SECRET,
    PLISIO_PUBLIC_URL:url.origin,
    PORT:String(config.port),DISCORD_CHANNEL_ID:config.discordChannelId,
    PLISIO_ENABLED:'true',PLISIO_DB_PATH:config.databasePath,
    PLISIO_PERSISTENT_STORAGE_CONFIRMED:'yes',
    PLISIO_PAYOUTS_ENABLED:String(config.payoutsEnabled),
    PLISIO_MAX_PAYOUT_LTC:config.maxPayoutLtc,PLISIO_MAX_DEPOSIT_LTC:config.maxDepositLtc,
  };
}
module.exports={config,environment};
