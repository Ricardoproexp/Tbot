# Tbot — TimeWall + FaucetPay withdrawal relay

Northflank hosts the authenticated relay for TimeWall callbacks and FaucetPay v2 **payouts only**. This integration intentionally has no deposit/invoice feature. RL'$ balances, withdrawal reservations, referrals and the user ledger remain in the Termux bot's local SQLite database.

## Architecture
- Termux/Python: account balances, withdrawal requests and approval; only reserves RL'$ before approval.
- Northflank/Node 24: authenticated FaucetPay API relay; v2 send endpoint with idempotency key.
- Discord: encrypted append-only journal for payout claims/results so the ephemeral Northflank filesystem can be recovered.
- TimeWall: existing postback endpoint remains unchanged.

Keep the service at **one replica**. Multiple replicas can cause Discord journal conflicts. Do not deploy overlapping instances.

## Northflank environment variables
Required:
- `TBOT_TOKEN`: Discord journal bot token (rotate if previously exposed).
- `TIMEWALL`: current TimeWall postback secret.
- `FAUCETPAY_SEND_KEY`: FaucetPay scoped API key with **send** permission only.
- `FAUCETPAY_READ_KEY`: FaucetPay scoped API key with **read** permission.
- `FAUCETPAY_BRIDGE_SECRET`: same random secret as Termux, at least 32 characters.

The Node config creates a temporary SQLite cache; Discord journal is the recovery source. It does not need a persistent volume. Keep the Discord bot's View Channel, Read Message History and Send Messages permissions in the configured journal channel.

## Termux environment
Set these in `termux.env` (do not commit the file):
- `FAUCETPAY_ENABLED=true`
- `FAUCETPAY_BRIDGE_URL=https://YOUR-NORTHFLANK-SERVICE-DOMAIN`
- `FAUCETPAY_BRIDGE_SECRET` (same as Northflank)
- `FAUCETPAY_USD_PER_UNIT=1` (RL'$ conversion basis; adjust only if the internal unit's USD value changes)

The available withdrawal currencies are BTC, LTC and SOL. Recipient must be a FaucetPay-payable username/email/address for the selected coin; recipient eligibility is checked before approval and again before sending. Amounts are converted using a live USD price feed and sent as integer smallest units. The v2 send API does not expose a payout fee quote, so the bot displays that fees are not estimated. This flow is for FaucetPay-payable recipients; it is not a separate direct on-chain withdrawal service.

## Safety behavior
- Every payout has an idempotency key derived from the withdrawal request. Retrying a request uses the same key.
- If the result is uncertain, the RL'$ reservation remains held and the request is flagged for manual review; do not create another request or change the key.
- Definite provider rejections are marked FAILED and may be refunded by an administrator.
- Successful v2 response marks the withdrawal paid. Reconcile ambiguous requests in FaucetPay dashboard before any manual balance change.
- API keys are never logged or committed.

## Deploy
1. Stop the current Northflank instance; deploy this branch with Node 24.
2. Configure environment variables above and build/deploy.
3. Confirm `/health` reports TimeWall configured and FaucetPay enabled, then verify Discord journal recovery succeeds.
4. Update Termux `termux.env`, restart the bot, and test with a small payout to your own FaucetPay account.
5. Do not enable real payouts until API key scopes, balances, destination and unit conversion are checked.

The old `plisio.cjs` and Plisio test files are retained in the repository history/branch as legacy files, but are no longer loaded by the new service.
