# Prism License Worker — Setup Guide

## 1. Create KV Namespace

```bash
cd prism-license-worker
wrangler kv namespace create LICENSES
```

Copy the `id` from the output and paste it into `wrangler.toml`.

## 2. Set Environment Variables

```bash
wrangler secret put PADDLE_WEBHOOK_SECRET
# Enter your Paddle webhook secret key when prompted
```

## 3. Deploy

```bash
npm install
wrangler deploy
```

Note the deployed URL (e.g. `https://prism-license-worker.your-subdomain.workers.dev`).

## 4. Configure Paddle Webhooks

1. Go to [Paddle Dashboard](https://sandbox-vendors.paddle.com/) → **Developer Tools** → **Webhooks**
2. Add a new webhook:
   - **URL:** `https://prism-license-worker.your-subdomain.workers.dev/api/paddle-webhook`
   - **Events to subscribe:**
     - `subscription.created`
     - `subscription.updated`
     - `subscription.cancelled`
     - `transaction.completed`
3. Copy the **Webhook Secret Key** and set it as `PADDLE_WEBHOOK_SECRET` env var

## 5. Update Extension

In `content-search.js`, update the `LICENSE_SERVER` constant:

```javascript
const LICENSE_SERVER = 'https://prism-license-worker.your-subdomain.workers.dev';
```

## 6. Test

1. Open a test subscription in Paddle sandbox
2. Check that the webhook fires and creates a license key in KV
3. Enter the key in the Prism extension
4. Verify it validates correctly

---

## How It Works

1. **User pays** at getwalksafe.co.uk/drivepricing
2. **Paddle webhook** fires → Worker stores license key in KV
3. **User enters key** in Prism extension → Worker validates
4. **Extension unlocks** premium features

## License Key Format

Keys are stored as `PRISM-XXXX-XXXX-XXXX-XXXX`. When a user pays via Paddle, the webhook handler stores their license key. If Paddle doesn't generate keys natively, the worker generates them from the subscription ID.

## Paddle License Keys (Alternative)

If you want Paddle to generate license keys natively:

1. Paddle Dashboard → **Catalog** → **Products** → Enable **License Keys**
2. Paddle will generate a key for each new subscription
3. The key is sent to the customer via email AND in the webhook payload
4. Update `handleSubscriptionEvent` to read `payload.license_key` from Paddle's native key

## KV Storage Schema

Each license record:

```json
{
  "license_key": "PRISM-A1B2-C3D4-0000-0000",
  "subscription_id": "sub_123456",
  "email": "user@example.com",
  "status": "active",
  "plan": "pro",
  "current_period_end": "2026-09-25T00:00:00Z",
  "updated_at": "2026-08-25T00:00:00Z"
}
```
