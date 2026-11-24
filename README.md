# Tbot — TimeWall + FaucetPay withdrawal relay

Northflank hosts the authenticated relay for TimeWall callbacks and FaucetPay v2 payouts only. There is no deposit or invoice feature. RL'$ balances, withdrawal reservations, referrals and the user ledger remain in the Termux bot's local SQLite database.

## Architecture
- Termux/Python: account balances, withdrawal requests and admin approval.
- Northflank/Node 24: authenticated FaucetPay API relay, with idempotent payouts.
- Discord: encrypted append-only journal for payout claims and results, allowing recovery from ephemeral storage.
- TimeWall: existing postback endpoint.

Run exactly **one replica** to avoid journal conflicts. Do not run overlapping deployments.

## Northflank environment
- `TBOT_TOKEN`: Discord journal bot token.
- `TIMEWALL`: TimeWall postback secret.
- `FAUCETPAY_SEND_KEY`: FaucetPay API key with send scope.
- `FAUCETPAY_READ_KEY`: FaucetPay API key with read scope.
- `FAUCETPAY_BRIDGE_SECRET`: shared secret with Termux, at least 32 characters.
- `FAUCETPAY_WEBHOOK_SECRET`: signing secret configured in FaucetPay.

The service uses a temporary SQLite cache restored from the Discord journal; no persistent volume is required. Give the Discord bot View Channel, Read Message History and Send Messages permissions in the journal channel.

## FaucetPay webhook
Configure the HTTPS URL `https://YOUR-NORTHFLANK-SERVICE-DOMAIN/webhooks/faucetpay` in FaucetPay for `payout.failed` events. Set the webhook signing secret in Northflank. Requests are verified using HMAC against the raw body. Failed payouts are relayed to Termux for matching and safe, idempotent refund handling.

## Termux environment
Set in `termux.env` (do not commit):
- `FAUCETPAY_ENABLED=true`
- `FAUCETPAY_BRIDGE_URL=https://YOUR-NORTHFLANK-SERVICE-DOMAIN`
- `FAUCETPAY_BRIDGE_SECRET` (same secret as Northflank)
- `FAUCETPAY_USD_PER_UNIT=1` (RL'$ conversion basis)

Supported withdrawal currencies: BTC, LTC and SOL. Recipients must be FaucetPay-payable for the selected currency. Recipient eligibility and provider balance are checked before payout. Amounts use integer smallest units. FaucetPay v2 does not provide a fee quote; fees are not estimated.

## Safety
- Payouts use a stable idempotency key; retries cannot create a duplicate send.
- Uncertain outcomes remain reserved for manual reconciliation; do not create another withdrawal or change its key.
- Definitive rejections are marked failed and can be refunded by an administrator.
- Successful provider responses mark the payout paid.
- API keys are never logged or committed.

## Deployment checklist
1. Deploy on Northflank with Node 24 and one replica.
2. Set the environment variables above.
3. Verify `/health` and Discord journal recovery.
4. Configure the FaucetPay webhook.
5. Update Termux's `termux.env`, restart the bot and test a small payout to your own FaucetPay account.
6. Confirm key scopes, balance, recipient and conversion settings before enabling real user payouts.
