
'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const config=Object.freeze({
  port:3001,
  discordChannelId:'1559371192400613450',
  // SQLite is only a disposable cache, restored from the Discord journal.
  databasePath:null,
  maxPayoutLtc:'1',
  maxDepositLtc:'10',
  payoutsEnabled:true,
});
function environment(secrets=process.env) {
  for(const key of ['TBOT_TOKEN','TIMEWALL','PLISIO_API_KEY','PLISIO_BRIDGE_SECRET','PLISIO_PUBLIC_URL'])
    if(!secrets[key]) throw Error('Missing '+key);
  const url=new URL(secrets.PLISIO_PUBLIC_URL);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/')
    throw Error('PLISIO_PUBLIC_URL must be an HTTPS origin without a path');
  return {
    TBOT_TOKEN:secrets.TBOT_TOKEN,TIMEWALL:secrets.TIMEWALL,
    PLISIO_API_KEY:secrets.PLISIO_API_KEY,PLISIO_BRIDGE_SECRET:secrets.PLISIO_BRIDGE_SECRET,
    PLISIO_PUBLIC_URL:url.origin,
    PORT:String(config.port),DISCORD_CHANNEL_ID:config.discordChannelId,
    PLISIO_ENABLED:'true',PLISIO_DB_PATH:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'tbot-cache-')),'plisio.sqlite'),
    PLISIO_STORAGE_MODE:'discord',
    PLISIO_PAYOUTS_ENABLED:String(config.payoutsEnabled),
    PLISIO_MAX_PAYOUT_LTC:config.maxPayoutLtc,PLISIO_MAX_DEPOSIT_LTC:config.maxDepositLtc,
  };
}
module.exports={config,environment};
