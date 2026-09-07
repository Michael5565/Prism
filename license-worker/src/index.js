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

    // POST /api/validate-license — validates a license key + device activation
    if (url.pathname === '/api/validate-license' && request.method === 'POST') {
      return handleValidateLicense(request, env, corsHeaders);
    }

    // POST /api/deactivate-license — removes a device from a license key
    if (url.pathname === '/api/deactivate-license' && request.method === 'POST') {
      return handleDeactivateLicense(request, env, corsHeaders);
    }

    // GET /api/health — health check
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/test-email — send a test email (remove after debugging)
    if (url.pathname === '/api/test-email' && request.method === 'POST') {
      try {
        const { to, key } = await request.json();
        if (!to || !key) return new Response(JSON.stringify({ error: 'missing to or key' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await sendLicenseEmail(to, key, env);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
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
    const { key, device_id } = await request.json();

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

    // ── Device concurrency limit (max 2 simultaneous activations) ──────
    if (device_id && typeof device_id === 'string') {
      const MAX_DEVICES = 2;
      const devicesKey = `devices:${normalized}`;
      let devices = [];
      try { devices = JSON.parse(await env.LICENSES.get(devicesKey)) || []; } catch (_) {}
      const now = Date.now();
      // Purge stale entries (older than 30 days without heartbeat)
      devices = devices.filter((d) => now - (d.lastSeen || 0) < 30 * 24 * 60 * 60 * 1000);
      const existing = devices.find((d) => d.id === device_id);
      if (existing) {
        // Already registered — refresh heartbeat
        existing.lastSeen = now;
        await env.LICENSES.put(devicesKey, JSON.stringify(devices), { expirationTtl: 365 * 24 * 60 * 60 });
      } else if (devices.length >= MAX_DEVICES) {
        return new Response(
          JSON.stringify({
            valid: false,
            error: 'This key is already activated on 2 devices. Purchase another key for additional devices.',
            deviceLimit: true,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        // New device — register it
        devices.push({ id: device_id, activatedAt: now, lastSeen: now });
        await env.LICENSES.put(devicesKey, JSON.stringify(devices), { expirationTtl: 365 * 24 * 60 * 60 });
      }
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

// ─── Device Deactivation ─────────────────────────────────────────────────────

async function handleDeactivateLicense(request, env, corsHeaders) {
  try {
    const { key, device_id } = await request.json();
    if (!key || !device_id) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing key or device_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const normalized = key.trim().toUpperCase();
    const devicesKey = `devices:${normalized}`;
    let devices = [];
    try { devices = JSON.parse(await env.LICENSES.get(devicesKey)) || []; } catch (_) {}
    const before = devices.length;
    devices = devices.filter((d) => d.id !== device_id);
    await env.LICENSES.put(devicesKey, JSON.stringify(devices), { expirationTtl: 365 * 24 * 60 * 60 });
    return new Response(
      JSON.stringify({ ok: true, removed: before - devices.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Server error' }),
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
      // Paddle v3 events — subscriptions + transactions.
      // NOTE: Paddle spells it "canceled" (US). Accept both.
      // transaction.paid fires first (payment captured, before sub id
      // attached); transaction.updated carries sub id once processing adds
      // it; subscription.created carries transaction_id linking back to txn;
      // customer.created carries the email (txn events carry only ctm id).
      case 'customer.created':
      case 'customer.updated':
      case 'transaction.updated':
      case 'subscription.created':
      case 'subscription.activated':
      case 'subscription.updated':
      case 'subscription.canceled':
      case 'subscription.cancelled':
      case 'subscription.past_due':
      case 'subscription.trialing':
      case 'subscription.resumed':
      case 'subscription.paused':
      case 'transaction.billed':
      case 'transaction.paid':
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
  // One customer = one key: prefer customer_id as the canonical seed so
  // transaction.completed and subscription.* events converge on the same
  // key even when they arrive out of order or the txn has no sub id yet.
  // (transaction.completed carries NO email — only customer_id /
  //  subscription_id / invoice_id. Email is best-effort via custom_data or
  //  subscription events. The website looks keys up by txn/sub/ctm/inv id,
  //  never by email alone.)
  const isV3 = !!payload.event_type;
  const eventName = payload.event_type || payload.alert_name || '';
  const isTxnEvent = eventName.startsWith('transaction.');
  const isCustomerEvent = eventName.startsWith('customer.');
  const isTxnComplete = eventName === 'transaction.completed'
    || eventName === 'transaction.billed'
    || eventName === 'transaction.updated'
    || eventName === 'transaction.paid';

  // customer.created/updated carry identity only (no license to mint).
  // Store ctm:<id> -> email so /api/get-license can resolve by customer id,
  // and backfill the email onto any license record already indexed for it.
  // Also send the license email if a record already exists but was stored
  // without an email (transaction.completed arrives before customer.created).
  if (isV3 && isCustomerEvent) {
    const c = payload.data || {};
    const cid = c.id || undefined;
    const cEmail = c.email || undefined;
    if (cid && cEmail && cEmail.includes('@')) {
      try {
        await env.LICENSES.put(`ctm:${cid}`, cEmail, { expirationTtl: 365 * 24 * 60 * 60 });
        await env.LICENSES.put(`ctmemail:${cid}`, cEmail, { expirationTtl: 365 * 24 * 60 * 60 });
        // Backfill email onto any existing license record for this customer
        const linked = await env.LICENSES.get(`ctmkey:${cid}`);
        if (linked) {
          const rec = await env.LICENSES.get(linked, { type: 'json' });
          if (rec) {
            const needsBackfill = !rec.email || rec.email !== cEmail;
            if (needsBackfill) {
              rec.email = cEmail;
              rec.updated_at = new Date().toISOString();
              await env.LICENSES.put(linked, JSON.stringify(rec), { expirationTtl: 365 * 24 * 60 * 60 });
              await env.LICENSES.put(`email:${cEmail.toLowerCase()}`, linked, { expirationTtl: 365 * 24 * 60 * 60 });
            }
            // Always try to send email — transaction.completed may have
            // failed because customer.created hadn't arrived yet.
            console.log(`[Prism Worker] customer.created: sending email for ${linked.slice(0,8)}...`);
            try { await sendLicenseEmail(cEmail, linked, env); } catch (e) { console.warn('[Prism Worker] Email send failed:', e); }
          }
        }
      } catch (_) {}
    }
    console.log(`[Prism Worker] Customer event: ${eventName} cid=${cid || '?'}`);
    return;
  }

  let subscriptionId, txnId, linkedTxnId, customerId, invoiceId, checkoutId, email, licenseKey, status, currentPeriodEnd, plan;

  if (isV3) {
    // Paddle v3 format — see https://developer.paddle.com/webhooks/transactions/transaction-completed/
    const data = payload.data || {};
    if (isTxnEvent) {
      txnId = data.id || undefined; // txn_...
      subscriptionId = data.subscription_id || undefined; // sub_... or null
      customerId = data.customer_id || undefined; // ctm_...
      invoiceId = data.invoice_id || data.invoice_number || undefined; // inv_...
      checkoutId = data.checkout?.id || data.checkout_id || undefined; // che_...
    } else {
      // subscription.* — data.id is the sub id; transaction_id links the
      // originating txn so txn polling resolves even before txn.completed.
      subscriptionId = data.subscription_id || data.id || undefined;
      linkedTxnId = data.transaction_id || undefined;
      if (linkedTxnId && !txnId) txnId = linkedTxnId;
      customerId = data.customer_id || undefined;
      invoiceId = data.invoice_id || undefined;
      checkoutId = data.checkout?.id || data.checkout_id || undefined;
    }
    email = data.customer_email || data.customer?.email
      || data.custom_data?.email || data.email || undefined;
    if (email && /^(inv|txn|sub|ctm)_/i.test(email)) email = undefined; // guard: never treat an id as email
    status = isTxnComplete ? 'active' : (data.status || 'active');
    currentPeriodEnd = data.next_billed_at || data.next_transaction?.time
      || data.current_billing_period?.ends_at || data.ends_at || null;
    plan = data.custom_data?.plan || 'pro';
  } else {
    // Paddle v2 format
    subscriptionId = payload.subscription_id;
    email = payload.email;
    licenseKey = payload.license_key || undefined;
    status = isTxnComplete ? 'active' : mapPaddleStatus(payload.status);
    currentPeriodEnd = payload.next_bill_date || null;
    plan = payload.plan_name || 'pro';
  }

  // If no license key in webhook, generate one from the canonical seed.
  // Priority: customer > subscription > email > txn > invoice — so the
  // txn event and the later subscription event for the same buyer converge.
  if (!licenseKey) {
    const seed = customerId || subscriptionId || email || txnId || invoiceId;
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
    customer_id: customerId || (prev && prev.customer_id) || null,
    transaction_id: txnId || (prev && prev.transaction_id) || null,
    invoice_id: invoiceId || (prev && prev.invoice_id) || null,
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
  if (customerId) {
    await env.LICENSES.put(`ctm:${customerId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
    await env.LICENSES.put(`ctmkey:${customerId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }
  if (invoiceId) {
    await env.LICENSES.put(`inv:${invoiceId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }
  if (linkedTxnId && linkedTxnId !== txnId) {
    await env.LICENSES.put(`txn:${linkedTxnId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }
  // ctmkey: reverse index customer -> key (used to backfill email from
  // customer.created onto the license). checkout: browser always has che id.
  if (customerId) {
    await env.LICENSES.put(`ctmkey:${customerId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }
  if (checkoutId) {
    await env.LICENSES.put(`checkout:${checkoutId}`, normalized, {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }

  console.log(`[Prism Worker] Stored license: ${normalized.slice(0, 8)}... status=${status}`);

  // ── Send license key email via Resend (best-effort, non-blocking) ────
  // transaction.completed events carry NO email (only customer_id), so
  // look up the email from ctmemail:<customer_id> (set by customer.created).
  // Do NOT fall back to another license record's email — each customer has
  // their own ctmemail: entry, and reusing an old one sends to the wrong address.
  let sendTo = email;
  if ((!sendTo || !sendTo.includes('@')) && customerId) {
    try {
      const lookup = await env.LICENSES.get(`ctmemail:${customerId}`);
      if (lookup && lookup.includes('@')) {
        sendTo = lookup;
        record.email = sendTo;
        await env.LICENSES.put(normalized, JSON.stringify(record), { expirationTtl: 365 * 24 * 60 * 60 });
        await env.LICENSES.put(`email:${sendTo.toLowerCase()}`, normalized, { expirationTtl: 365 * 24 * 60 * 60 });
      }
    } catch (_) {}
  }
  if (sendTo && sendTo.includes('@')) {
    try { await sendLicenseEmail(sendTo, normalized, env); } catch (e) { console.warn('[Prism Worker] Resend email failed:', e); }
  } else {
    console.log(`[Prism Worker] No email for ${normalized.slice(0, 8)}... (cid=${customerId || '?'}) — will send when customer.created arrives`);
  }
}

async function sendLicenseEmail(to, key, env) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) { console.log('[Prism Worker] RESEND_API_KEY unset — skipping email'); return; }
  const from = env.EMAIL_FROM || 'Prism <noreply@getwalksafe.co.uk>';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#101828;background:#f6f7f9;margin:0;padding:32px 16px}h2{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.6;margin:0 0 12px;color:#344054}.key-box{background:#f5f7f2;border:1.5px solid #e0e8df;border-radius:10px;padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.04em;text-align:center;margin:20px 0;color:#101828}.footer{margin-top:24px;font-size:12px;color:#98a2b3}</style></head><body><h2>Your Prism Pro license key</h2><p>Thanks for your purchase. Here's your license key — open the Prism extension in Google Drive and choose <b>Enter license key</b> to unlock Pro.</p><div class="key-box">${key}</div><p>This key works on up to 2 devices at once. If you need a third, purchase another key from <a href="https://getwalksafe.co.uk/prismpricing" style="color:#c2760a">getwalksafe.co.uk/prismpricing</a>.</p><p style="font-size:13px;color:#667085">Questions? Reply to this email or contact <a href="mailto:support@getwalksafe.co.uk" style="color:#c2760a">support@getwalksafe.co.uk</a>.</p><div class="footer">Prism — Drive Search · Docs Dark Mode</div></body></html>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: 'Your Prism Pro license key', html }),
  });
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
  const customer = url.searchParams.get('customer') || url.searchParams.get('ctm');
  const checkout = url.searchParams.get('checkout') || url.searchParams.get('che');
  const inv = url.searchParams.get('inv') || url.searchParams.get('invoice');
  try {
    let key = null;
    const tryGet = async (k) => { try { return await env.LICENSES.get(k); } catch (_) { return null; } };
    if (email && email.includes('@')) key = await tryGet(`email:${email.toLowerCase()}`);
    if (!key && sub) key = await tryGet(`sub:${sub}`);
    if (!key && txn) key = await tryGet(`txn:${txn}`);
    if (!key && txn) key = await tryGet(`sub:${txn}`); // legacy: old build stored txn ids under sub:
    if (!key && sub) key = await tryGet(`txn:${sub}`); // reverse fallback
    if (!key && customer) {
      key = await tryGet(`ctm:${customer}`);
      if (!key && !customer.startsWith('ctm_')) key = await tryGet(`ctm:ctm_${customer}`);
    }
    if (!key && checkout) {
      key = await tryGet(`checkout:${checkout}`);
      if (!key && !checkout.startsWith('che_')) key = await tryGet(`checkout:che_${checkout}`);
    }
    if (!key && inv) {
      key = await tryGet(`inv:${inv}`);
      if (!key && !inv.startsWith('inv_')) key = await tryGet(`inv:inv_${inv}`);
    }
    // email param may itself be a ctm id when the callback had no email yet
    if (!key && email && !email.includes('@')) {
      key = await tryGet(`ctm:${email}`);
    }
    if (!key) {
      return new Response(JSON.stringify({ found: false, error: 'No license yet — webhook may be delayed 10-30s. Check email or try again.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const rec = await env.LICENSES.get(key, { type: 'json' });
    return new Response(JSON.stringify({ found: true, key, status: rec?.status || 'active', email: rec?.email || email }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ found: false, error: 'Server error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function generateLicenseKey(seedId) {
  // Deterministic key from canonical seed (customer/sub/txn id).
  // Format: PRISM-XXXX-XXXX-XXXX-XXXX (16 hex chars, 64-bit via cyrb53 x2).
  // Legacy keys PRISM-XXXX-XXXX-0000-0000 still validate via exact lookup.
  const s = String(seedId);
  const h1 = cyrb53(s, 0x9e37);
  const h2 = cyrb53(s, 0x85eb);
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).toUpperCase();
  return `PRISM-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
