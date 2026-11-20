
'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const config=Object.freeze({
  port:3001,
  discordChannelId:'1559371192400613450',
  // SQLite is only a disposable cache, restored from the Discord journal.
  databasePath:null,
  usdPerInternalUnit:'1',
});
function environment(secrets=process.env) {
  for(const key of ['TBOT_TOKEN','TIMEWALL','FAUCETPAY_SEND_KEY','FAUCETPAY_READ_KEY','FAUCETPAY_BRIDGE_SECRET'])
    if(!secrets[key]) throw Error('Missing '+key);
  return {
    TBOT_TOKEN:secrets.TBOT_TOKEN,TIMEWALL:secrets.TIMEWALL,
    FAUCETPAY_SEND_KEY:secrets.FAUCETPAY_SEND_KEY,FAUCETPAY_READ_KEY:secrets.FAUCETPAY_READ_KEY,FAUCETPAY_BRIDGE_SECRET:secrets.FAUCETPAY_BRIDGE_SECRET,
    PORT:String(config.port),DISCORD_CHANNEL_ID:config.discordChannelId,
    FAUCETPAY_ENABLED:'true',FAUCETPAY_DB_PATH:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'tbot-cache-')),'faucetpay.sqlite'),
    FAUCETPAY_STORAGE_MODE:'discord',
    FAUCETPAY_PERSISTENT_STORAGE_CONFIRMED:'yes',FAUCETPAY_USD_PER_UNIT:String(config.usdPerInternalUnit),
  };
}
module.exports={config,environment};
