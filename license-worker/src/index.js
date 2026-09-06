// Prism License Worker — Cloudflare Worker
// Validates Paddle license keys for the Prism Chrome extension

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // POST /api/paddle-webhook — receives Paddle subscription events
    if (url.pathname === '/api/paddle-webhook' && request.method === 'POST') {
      const rawBody = await request.text();
      const okSig = await verifyPaddleSignature(request, env, rawBody);
      if (!okSig) {
        console.log('[Prism Worker] Rejected webhook: bad signature');
        return new Response('Bad signature', { status: 401, headers: corsHeaders });
      }
      return handlePaddleWebhook(rawBody, env, corsHeaders);
    }

    // POST /api/validate-license — validates a license key
    if (url.pathname === '/api/validate-license' && request.method === 'POST') {
      return handleValidateLicense(request, env, corsHeaders);
    }

    // GET /api/health — health check
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/get-license?email=... — retrieve key just after checkout (display on website)
    if (url.pathname === '/api/get-license' && request.method === 'GET') {
      return handleGetLicense(request, env, corsHeaders);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

// ─── License Validation ──────────────────────────────────────────────────────

async function handleValidateLicense(request, env, corsHeaders) {
  try {
    const { key } = await request.json();

    if (!key || typeof key !== 'string') {
      return new Response(
        JSON.stringify({ valid: false, error: 'Missing license key' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const normalized = key.trim().toUpperCase();

    // Look up license in KV
    const record = await env.LICENSES.get(normalized, { type: 'json' });

    if (!record) {
      return new Response(
        JSON.stringify({ valid: false, error: 'Invalid license key' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check expiry first — cancelled subscriptions remain valid until period end + grace
    if (record.current_period_end) {
      const gracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 days grace
      const expiry = new Date(record.current_period_end).getTime() + gracePeriod;
      if (Date.now() > expiry) {
        return new Response(
          JSON.stringify({ valid: false, error: 'Subscription expired', status: record.status }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    // Allow active, trialing, past_due, paused, cancelled as valid until expiry.
    // Legacy transaction-sourced records may carry raw transaction statuses.
    // Only hard invalid statuses are deleted/unknown.
    const allowStatuses = new Set(['active', 'trialing', 'past_due', 'paused', 'cancelled', 'completed', 'billed', 'paid']);
    if (record.status && !allowStatuses.has(record.status)) {
      return new Response(
        JSON.stringify({
          valid: false,
          error: `Subscription ${record.status}`,
          status: record.status,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        email: record.email,
        plan: record.plan || 'pro',
        currentPeriodEnd: record.current_period_end,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ valid: false, error: 'Server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

// ─── Paddle Webhook Handler ──────────────────────────────────────────────────

// Paddle Billing signs webhooks: `Paddle-Signature: ts=<unix>;h1=<hmac-hex>`
// where h1 = HMAC-SHA256(secret, "<ts>:<raw-body>"). Reject forgeries so
// random POSTs can't mint licenses. If no secret is configured (local dev),
// allow through with a warning.
async function verifyPaddleSignature(request, env, rawBody) {
  try {
    const secret = env.PADDLE_WEBHOOK_SECRET;
    if (!secret) {
      console.log('[Prism Worker] WARNING: PADDLE_WEBHOOK_SECRET unset — skipping verification (dev only)');
      return true;
    }
    const sig = request.headers.get('Paddle-Signature') || '';
    const parts = {};
    sig.split(';').forEach((s) => {
      const i = s.indexOf('=');
      if (i > 0) parts[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    if (!parts.ts || !parts.h1) return false;
    if (Math.abs(Date.now() / 1000 - Number(parts.ts)) > 15 * 60) return false; // replay guard
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.ts}:${rawBody}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex.length !== parts.h1.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.h1.charCodeAt(i);
    return diff === 0;
  } catch (_) {
    return false;
  }
}

async function handlePaddleWebhook(rawBody, env, corsHeaders) {
  try {
    const payload = JSON.parse(rawBody);

    // Paddle v2 webhooks send alert_name in the body
    // Paddle v3 (inbound) webhooks send event_type
    const eventName = payload.alert_name || payload.event_type;

    if (!eventName) {
      return new Response('Missing event name', { status: 400, headers: corsHeaders });
    }

    console.log(`[Prism Worker] Webhook event: ${eventName}`);

    switch (eventName) {
      // Paddle v2 events
      case 'subscription_created':
      case 'subscription_updated':
      case 'subscription_cancelled':
      case 'subscription_payment_succeeded':
      case 'subscription_payment_failed':
      // Paddle v3 events
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.cancelled':
      case 'transaction.completed':
        await handleSubscriptionEvent(payload, env);
        break;
      default:
        console.log(`[Prism Worker] Unhandled event: ${eventName}`);
    }

    return new Response('OK', { headers: corsHeaders });
  } catch (e) {
    console.error('[Prism Worker] Webhook error:', e);
    return new Response('Error', { status: 500, headers: corsHeaders });
  }
}

async function handleSubscriptionEvent(payload, env) {
  // Extract common fields — handle both Paddle v2 and v3 formats.
  // One customer = one key: prefer the subscription id as the canonical seed
  // so transaction.completed and subscription.* events converge on the same
  // key (previously each minted its own). Email is best-effort only — the
  // website looks keys up by txn/sub id, never by email.
  const isV3 = !!payload.event_type;
  const eventName = payload.event_type || payload.alert_name || '';
  const isTxn = eventName === 'transaction.completed';

  let subscriptionId, txnId, email, licenseKey, status, currentPeriodEnd, plan;

  if (isV3) {
    // Paddle v3 format
    const data = payload.data || {};
    txnId = isTxn ? data.id : undefined;
    subscriptionId = data.subscription_id || (!isTxn ? data.id : undefined);
    email = data.customer_email || data.customer?.email || data.custom_data?.email || data.email || undefined;
    status = isTxn ? 'active' : (data.status || 'active');
    currentPeriodEnd = data.next_billed_at || data.next_transaction?.time
      || data.current_billing_period?.ends_at || data.ends_at || null;
    plan = data.custom_data?.plan || 'pro';
  } else {
    // Paddle v2 format
    subscriptionId = payload.subscription_id;
    email = payload.email;
    licenseKey = payload.license_key || undefined;
    status = isTxn ? 'active' : mapPaddleStatus(payload.status);
    currentPeriodEnd = payload.next_bill_date || null;
    plan = payload.plan_name || 'pro';
  }

  // If no license key in webhook, generate one from the canonical seed
  if (!licenseKey) {
    const seed = subscriptionId || txnId || email;
    if (seed) licenseKey = generateLicenseKey(seed);
  }

  if (!licenseKey) {
    console.log('[Prism Worker] No license key found in event, skipping');
    return;
  }

  const normalized = licenseKey.toUpperCase();

  // Merge with any existing record — never clobber a known period end or
  // email with an event that lacks them (transaction events often do).
  let prev = null;
  try { prev = await env.LICENSES.get(normalized, { type: 'json' }); } catch (_) {}
  const record = {
    license_key: normalized,
    subscription_id: subscriptionId || (prev && prev.subscription_id) || null,
    email: email || (prev && prev.email) || null,
    status: status || (prev && prev.status) || 'active',
    plan: plan || (prev && prev.plan) || 'pro',
    current_period_end: currentPeriodEnd || (prev && prev.current_period_end) || null,
    updated_at: new Date().toISOString(),
  };

  await env.LICENSES.put(normalized, JSON.stringify(record), {
    expirationTtl: 365 * 24 * 60 * 60, // 1 year max
  });
  // also index by email for /api/get-license display (website)
  if (email) {
    await env.LICENSES.put(`email:${email.toLowerCase()}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }
  if (subscriptionId) {
    await env.LICENSES.put(`sub:${subscriptionId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }
  if (txnId) {
    await env.LICENSES.put(`txn:${txnId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }

  console.log(`[Prism Worker] Stored license: ${normalized.slice(0, 8)}... status=${status}`);
}

function mapPaddleStatus(paddleStatus) {
  const map = {
    active: 'active',
    deleted: 'cancelled',
    paused: 'paused',
    past_due: 'past_due',
    trialing: 'active',
  };
  return map[paddleStatus] || paddleStatus;
}

async function handleGetLicense(request, env, corsHeaders) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email');
  const sub = url.searchParams.get('sub');
  const txn = url.searchParams.get('txn');
  try {
    let key = null;
    if (email) key = await env.LICENSES.get(`email:${email.toLowerCase()}`);
    if (!key && sub) key = await env.LICENSES.get(`sub:${sub}`);
    if (!key && txn) key = await env.LICENSES.get(`txn:${txn}`);
    if (!key && txn) key = await env.LICENSES.get(`sub:${txn}`); // fallback: txn id may be sub id
    if (!key) {
      return new Response(JSON.stringify({ found: false, error: 'No license yet — webhook may be delayed 10-30s. Check email or try again.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const rec = await env.LICENSES.get(key, { type: 'json' });
    return new Response(JSON.stringify({ found: true, key, status: rec?.status || 'active', email: rec?.email || email }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ found: false, error: 'Server error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function generateLicenseKey(subscriptionId) {
  // Generate a deterministic license key from subscription ID
  // Format: PRISM-XXXX-XXXX-XXXX-XXXX
  const sub = String(subscriptionId);
  let hash = 0;
  for (let i = 0; i < sub.length; i++) {
    const char = sub.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0').toUpperCase();
  return `PRISM-${hex.slice(0, 4)}-${hex.slice(4, 8)}-0000-0000`;
}
