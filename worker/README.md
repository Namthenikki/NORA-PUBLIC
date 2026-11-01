# Credit service

A small Cloudflare Worker that runs on the free tier. It never sees anyone's
handwriting or documents, because Likho renders on the user's laptop. Its only
job is keeping the page balance honest:

| Endpoint | What it does |
|---|---|
| `POST /v1/session` | Sign-in. Grants the 10 free pages once per Google account **and** once per laptop. |
| `GET /v1/balance` | Pages left |
| `POST /v1/buy` `{pack}` | Razorpay payment link for a pack: `p10`, `p25`, `p50` or `p100` (₹2/page) |
| `POST /v1/voucher` `{machine, pages}` | Takes pages off the balance and returns an Ed25519-signed voucher for that laptop |
| `POST /webhooks/razorpay` | Credits a paid pack exactly once (signature-checked, replay-proof) |
| `GET /v1/public-key` | The key the app verifies vouchers with |

Every `/v1` call carries the user's Google ID token as `Authorization: Bearer`.
`machine` is a SHA-256 of the laptop's hardware ID, never the ID itself.

## Test

```
npm test
```

The tests run against an in-memory SQLite stand-in for D1, a fake Google
sign-in and a stubbed Razorpay. They cover forged, expired and wrong-app
tokens; free pages being given once per account and once per laptop; vouchers
that can't be edited or overdrawn; and webhooks that can't be faked or
replayed.

## Deploy (free tier)

1. Install Wrangler and log in:
   ```
   npm install
   npx wrangler login
   ```
2. Create the database. Paste the id it prints into `wrangler.toml`, then
   apply the schema:
   ```
   npx wrangler d1 create likho-credits
   npm run migrate
   ```
3. Make the voucher keys, then store the private key as a secret. Put the
   public key into `wrangler.toml` and into the Likho app.
   ```
   npm run keygen
   npx wrangler secret put VOUCHER_PRIVATE_KEY
   ```
4. Razorpay: create API keys, and a webhook for the `payment_link.paid` event
   pointing at `https://<worker-url>/webhooks/razorpay`. Then store all three
   values as secrets:
   ```
   npx wrangler secret put RAZORPAY_KEY_ID
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   ```
5. Google: in Google Cloud console, create an OAuth client of type
   **Desktop app** and put its client ID in `GOOGLE_CLIENT_ID`.
6. Deploy:
   ```
   npm run deploy
   ```

Secrets live only in Cloudflare's encrypted settings. They are never committed
here.
