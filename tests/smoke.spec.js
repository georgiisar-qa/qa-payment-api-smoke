// ============================================================
// SMOKE S1–S14 — "is the payment platform alive?" (P0, < 2 min). One self-contained file.
//   S1  POST /payments valid            -> 200 + payment_id
//   S2  Same Idempotency-Key twice       -> 200 + 422 (in-progress)
//   S3  No Idempotency-Key twice         -> 2 distinct payment_id
//   S4  No X-Signature                   -> 401/403
//   S5  GET /balances signed             -> 200 + balances[]
//   S6  Payin creates a balanced ledger pair (Σ=0) — SKIP (needs ledger/core service)
//   S7  Payout without X-Signature        -> 401/403 (payout-path auth)
//   S8  Console login (SSO)              -> landing
//   S9  Country stop-list: US card on a ROW merchant -> 422 (blocked before the gateway)
//   S10 Refund                           -> 200 + webhook with a VALID signature
//   S11 GET /health on every service     -> 200
//   S12 Payout happy-path                -> 200 (or insufficient_balance)
//   S13 Wrong X-Signature (security)     -> 401/403 (HMAC is actually verified)
//   S14 Hosted checkout: no-card payin   -> 200 + processing_url; checkout page loads
//
// No dependency on any shared lib. Credentials come from .env (see .env.example).
// No secrets in code. Run: npx playwright test tests/smoke.spec.js
// ============================================================
import { test, expect, request as apiRequest } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// tiny .env loader (no dotenv dependency)
(function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const BASE = process.env.SMOKE_BASE_URL || 'https://payments.example.com';
// safety rail: refuse to run against anything that isn't clearly a test env
if (!/sandbox|staging|test|localhost|example/i.test(BASE) && process.env.SMOKE_ALLOW_NONSANDBOX !== '1') {
  throw new Error(`SMOKE_BASE_URL does not look like a test env: ${BASE} (set SMOKE_ALLOW_NONSANDBOX=1 to override)`);
}
function need(n) { const v = process.env[n]; if (!v) throw new Error(`missing env ${n} — fill in .env`); return v; }

// signed API client: HMAC-SHA256(secret, "<ts>.<body>") in X-Signature, ts in X-Timestamp
async function newApi({ bearer, apiSecret, baseURL = BASE }) {
  const ctx = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' } });
  const sig = (body = '') => { const ts = Math.floor(Date.now() / 1000); return { ts, signature: crypto.createHmac('sha256', apiSecret).update(`${ts}.${body}`).digest('hex') }; };
  return {
    async post(pathname, dataObj, { extraHeaders = {}, signed = true } = {}) {
      const body = JSON.stringify(dataObj); const headers = { ...extraHeaders };
      if (signed) { const { ts, signature } = sig(body); headers['X-Timestamp'] = String(ts); headers['X-Signature'] = signature; }
      return ctx.post(pathname, { headers, data: dataObj });
    },
    async get(pathname) { const { ts, signature } = sig(''); return ctx.get(pathname, { headers: { 'X-Timestamp': String(ts), 'X-Signature': signature } }); },
    dispose: () => ctx.dispose(),
  };
}
const jr = async (res) => { try { return JSON.parse(await res.text()); } catch { return {}; } };
const orderNo = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// standard non-routable test card numbers
const CARD_PAYIN = { pan: '4111111111111111', holder: 'smoke', cvv: '111', expires: '11/2029' };
const CARD_PAYOUT = { pan: '4242424242424242', expires: '11/2029' };
const CUST = { email: 'loadtest@example.com', ip: '203.0.113.10', phone: '10000000000' };
function payinBody({ amountMajor, currency, card = CARD_PAYIN, customer = CUST, callbackUrl = 'https://example.com/callback', orderNumber = orderNo('smk') }) {
  return { product: 'smoke', amount: Math.round(amountMajor * 100), currency, order_number: orderNumber, redirect_success_url: 'https://example.com/success', redirect_fail_url: 'https://example.com/fail', callback_url: callbackUrl, customer, card };
}
// clean payin merchant for S1-S5 (a stable, filter-free test shop returning 200)
const PAYIN_CCY = process.env.SMOKE_PAYIN_CCY || 'USD';
const payinApi = () => newApi({ bearer: need('SMOKE_PAYIN_A_BEARER'), apiSecret: need('SMOKE_PAYIN_A_SECRET') });

// ── S1 ──
test('S1: POST /payments valid -> 200 + payment_id', async () => {
  const api = await payinApi();
  const res = await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: PAYIN_CCY }));
  const body = await jr(res); await api.dispose();
  console.log(`S1: HTTP=${res.status()} payment_id=${body?.payment_id || '—'}`);
  expect(res.status()).toBe(200);
  expect(body?.success).toBeTruthy();
  expect(body?.payment_id, 'no payment_id').toBeTruthy();
});

// ── S2 ──
test('S2: same Idempotency-Key twice -> 200 + 422', async () => {
  const api = await payinApi();
  const key = `smk-idem-${Date.now()}`;
  const b = payinBody({ amountMajor: 1000, currency: PAYIN_CCY });
  const [r1, r2] = await Promise.all([
    api.post('/api/v1/payments', b, { extraHeaders: { 'Idempotency-Key': key } }),
    api.post('/api/v1/payments', b, { extraHeaders: { 'Idempotency-Key': key } }),
  ]);
  const s1 = r1.status(), s2 = r2.status(); await api.dispose();
  console.log(`S2: statuses=${s1}/${s2}`);
  // exactly one 200 + one 422, regardless of order — also catches double-accept (200/200) and double-reject (422/422)
  expect([s1, s2].sort((a, b) => a - b), `expected one 200 + one 422, got ${s1}/${s2}`).toEqual([200, 422]);
});

// ── S3 ──
test('S3: no Idempotency-Key twice -> 2 distinct payment_id', async () => {
  const api = await payinApi();
  const a = await jr(await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: PAYIN_CCY })));
  const b = await jr(await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: PAYIN_CCY })));
  await api.dispose();
  console.log(`S3: id1=${a?.payment_id} id2=${b?.payment_id}`);
  expect(a?.payment_id && b?.payment_id, 'both must be created').toBeTruthy();
  expect(a.payment_id).not.toBe(b.payment_id);
});

// ── S4 ──
test('S4: no X-Signature -> 401/403', async () => {
  const api = await payinApi();
  const res = await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: PAYIN_CCY }), { signed: false });
  const body = await jr(res); await api.dispose();
  console.log(`S4: HTTP=${res.status()} err=${body?.errors?.[0]?.kind || '—'}`);
  expect([401, 403], `expected 401/403 without a signature, got ${res.status()}`).toContain(res.status());
});

// ── S5 ──
test('S5: GET /balances signed -> 200 + array', async () => {
  const api = await payinApi();
  const res = await api.get('/api/v1/balances');
  const body = await jr(res); await api.dispose();
  console.log(`S5: HTTP=${res.status()} balances=${Array.isArray(body?.balances) ? body.balances.length : 'none'}`);
  expect(res.status()).toBe(200);
  expect(Array.isArray(body?.balances), 'no balances array').toBeTruthy();
});

// ── S6 (SKIP) ──
test.skip('S6: payin creates a balanced ledger pair Σ=0 — needs ledger/core service', async () => {});

// ── S7 (security): payout path enforces the signature too (mirror of S4 for payins) ──
test('S7: payout without X-Signature -> 401/403', async () => {
  const api = await newApi({ bearer: need('SMOKE_PAYOUT_BEARER'), apiSecret: need('SMOKE_PAYOUT_SECRET'), baseURL: process.env.SMOKE_PAYOUT_BASE_URL || BASE });
  const res = await api.post('/api/v1/payouts', { product: 'smoke', amount: 1000, currency: 'USD', order_number: orderNo('smk-s7'), redirect_success_url: 'https://example.com/success', redirect_fail_url: 'https://example.com/fail', callback_url: 'https://example.com/callback', customer: { email: CUST.email, ip: CUST.ip }, card: CARD_PAYOUT }, { signed: false });
  const body = await jr(res); await api.dispose();
  console.log(`S7: HTTP=${res.status()} err=${body?.errors?.[0]?.kind || '—'}`);
  expect([401, 403], `payout without a signature must be rejected, got ${res.status()}`).toContain(res.status());
});

// ── S8 (browser) ──
test('S8: Console login (SSO) -> landing', async ({ page }) => {
  test.setTimeout(60_000);
  const CORE = process.env.SMOKE_CORE_URL || 'https://console.example.com';
  await page.goto(`${CORE}/console/sessions/new`);
  const sso = page.getByRole('button', { name: /Continue with|Sign in with|SSO/i });
  if (await sso.isVisible({ timeout: 8000 }).catch(() => false)) {
    await sso.click();
    const u = page.getByRole('textbox', { name: /Username or email|Email/i });
    if (await u.isVisible({ timeout: 8000 }).catch(() => false)) {
      await u.fill(need('SMOKE_SSO_USER'));
      await page.getByRole('textbox', { name: /Password/i }).fill(need('SMOKE_SSO_PASS'));
      await page.getByRole('button', { name: /Sign In|Log in/i }).click();
    }
  }
  const coreHost = new URL(CORE).host;
  await page.waitForURL((url) => url.host.includes(coreHost) && !url.pathname.includes('/sessions/new'), { timeout: 30000 }).catch(() => {});
  const landed = page.url().includes(coreHost) && !page.url().includes('/sessions/new');
  console.log(`S8: url=${page.url()}`);
  expect(landed, `did not reach console landing: ${page.url()}`).toBeTruthy();
});

// ── S9 ──
test('S9: country stop-list — US card on a ROW merchant -> 422 (blocked before the gateway)', async () => {
  const api = await newApi({ bearer: need('SMOKE_ROW_BEARER'), apiSecret: need('SMOKE_ROW_SECRET') });
  const res = await api.post('/api/v1/payments', payinBody({ amountMajor: 100, currency: 'RUB', card: { ...CARD_PAYIN, pan: '4111111111111111' }, customer: { email: CUST.email, ip: '8.8.8.8', country: 'US', phone: '+12025550100' } }));
  const body = await jr(res); await api.dispose();
  const token = body?.token || null; const err = body?.errors?.[0];
  console.log(`S9: HTTP=${res.status()} token=${token || '—'} err=${err ? `${err.psp_code}/${err.kind}` : '—'}`);
  expect(res.status(), `US was not blocked: ${JSON.stringify(body).slice(0, 200)}`).toBe(422);
  expect(token, 'a US card must not reach the gateway').toBeFalsy();
});

// ── S10 ──
test('S10: refund -> 200 + webhook with a valid signature', async () => {
  // Gated to nightly: relies on the external webhook.site (flaky + slow for a fast MR gate).
  // For a prod gate, replace webhook.site with a self-hosted callback receiver to drop the external dependency.
  test.skip(!process.env.SMOKE_NIGHTLY, 'nightly-only: external webhook.site dependency');
  test.setTimeout(120_000);
  const bearer = need('SMOKE_REFUND_BEARER'), apiSecret = need('SMOKE_REFUND_SECRET'), webhookSecret = need('SMOKE_REFUND_WEBHOOK_SECRET');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wh = await apiRequest.newContext();
  const uuid = (await jr(await wh.post('https://webhook.site/token'))).uuid;
  const callbackUrl = `https://webhook.site/${uuid}`;
  const reqs = async () => { try { return (await jr(await wh.get(`https://webhook.site/token/${uuid}/requests?sorting=newest`))).data || []; } catch { return []; } };
  const bodyOf = (rq) => rq.content || (rq.request && rq.request.body) || '';
  const api = await newApi({ bearer, apiSecret });
  const pay = await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: 'INR', callbackUrl }));
  const paymentId = (await jr(pay))?.payment_id;
  let payinCb = null;
  for (let i = 0; i < 30 && !payinCb; i++) { payinCb = (await reqs()).find((rq) => /accepted|"status"|payment/i.test(bodyOf(rq))); if (!payinCb) await sleep(1500); }
  const seen = new Set((await reqs()).map((rq) => rq.uuid));
  const refRes = await api.post(`/api/v1/payments/${paymentId}/refund`, { amount: 50000, reason: 'smoke S10' });
  const refStatus = refRes.status(); const refText = await refRes.text();
  let refundCb = null;
  for (let i = 0; i < 30 && !refundCb; i++) { const fresh = (await reqs()).filter((rq) => !seen.has(rq.uuid)); refundCb = fresh.find((rq) => /refund/i.test(bodyOf(rq))) || fresh[0]; if (!refundCb) await sleep(1500); }
  let sigValid = false, sigNote = 'no callback';
  if (refundCb) {
    const h = Object.fromEntries(Object.entries(refundCb.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    if (!h['x-signature']) sigNote = 'no X-Signature';
    else { const exp = crypto.createHmac('sha256', webhookSecret).update(`${h['x-timestamp']}.${bodyOf(refundCb)}`).digest('hex'); sigValid = exp === h['x-signature']; sigNote = sigValid ? 'valid' : 'INVALID'; }
  }
  await api.dispose(); await wh.dispose();
  console.log(`S10: payin=${pay.status()} cb=${!!payinCb} refund=${refStatus} refundCb=${!!refundCb} sig=${sigNote}`);
  expect(pay.status()).toBe(200);
  expect(payinCb, 'no payin callback').toBeTruthy();
  expect(refStatus, `refund: ${refText.slice(0, 200)}`).toBeLessThan(400);
  expect(refundCb, 'no refund callback').toBeTruthy();
  expect(sigValid, `signature: ${sigNote}`).toBeTruthy();
});

// ── S11 ──
test('S11: GET /health on every service -> 200', async () => {
  // comma-separated list of health URLs in SMOKE_HEALTH_URLS
  const services = (process.env.SMOKE_HEALTH_URLS || 'https://payments.example.com/health,https://console.example.com/health')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ctx = await apiRequest.newContext(); const results = [];
  for (const u of services) { let code = 0; try { code = (await ctx.get(u, { timeout: 10_000 })).status(); } catch { code = -1; } results.push({ u, code }); }
  await ctx.dispose();
  const down = results.filter((r) => r.code !== 200);
  console.log('S11: ' + results.map((r) => `${r.code === 200 ? '✅' : '🔴'} ${r.u.replace('https://', '').replace('/health', '')}=${r.code}`).join(' '));
  expect(down, `not 200: ${down.map((d) => `${d.u}(${d.code})`).join(', ')}`).toHaveLength(0);
});

// ── S12 ──
test('S12: payout happy-path -> 200 (or insufficient_balance)', async () => {
  const api = await newApi({ bearer: need('SMOKE_PAYOUT_BEARER'), apiSecret: need('SMOKE_PAYOUT_SECRET'), baseURL: process.env.SMOKE_PAYOUT_BASE_URL || BASE });
  const res = await api.post('/api/v1/payouts', { product: 'smoke', amount: 1000, currency: 'USD', order_number: orderNo('smk-s12'), redirect_success_url: 'https://example.com/success', redirect_fail_url: 'https://example.com/fail', callback_url: 'https://example.com/callback', customer: { email: CUST.email, ip: CUST.ip }, card: CARD_PAYOUT });
  const rawText = await res.text(); await api.dispose();
  let body = {}; try { body = JSON.parse(rawText); } catch {}
  const err = body?.errors?.[0]; const funded = res.status() === 200 && body?.success === true;
  const noBal = res.status() === 422 && (/insufficient\s*balance/i.test(err?.description || '') || err?.kind === 'insufficient_balance');
  console.log(`S12: HTTP=${res.status()} ${funded ? 'funded' : noBal ? 'path ok, no balance' : `🔴 ${err?.kind}`}`);
  expect(funded || noBal, `payout broken: ${rawText.slice(0, 200)}`).toBeTruthy();
});

// ── S13 (security) ──
// S4 checks a signature is REQUIRED; S13 checks the HMAC is actually VERIFIED —
// a request signed with the wrong secret (valid Bearer) must be rejected.
test('S13: wrong X-Signature -> 401/403 (signature is actually verified)', async () => {
  const api = await newApi({ bearer: need('SMOKE_PAYIN_A_BEARER'), apiSecret: 'tampered-wrong-secret' });
  const res = await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: PAYIN_CCY }));
  const body = await jr(res); await api.dispose();
  console.log(`S13: HTTP=${res.status()} err=${body?.errors?.[0]?.kind || '—'}`);
  expect([401, 403], `a wrong signature must be rejected, got ${res.status()}`).toContain(res.status());
});

// ── S14: hosted checkout — payin WITHOUT a card -> 200 + processing_url; the page loads ──
test('S14: no-card payin -> checkout URL + checkout page responds < 400', async () => {
  const api = await payinApi();
  const res = await api.post('/api/v1/payments', payinBody({ amountMajor: 1000, currency: PAYIN_CCY, card: null }));
  const body = await jr(res); await api.dispose();
  const url = body?.processing_url;
  console.log(`S14: HTTP=${res.status()} processing_url=${url ? 'yes' : '—'}`);
  expect(res.status(), 'no-card payin').toBe(200);
  expect(url, 'no processing_url — nowhere to redirect the customer to pay').toBeTruthy();
  expect(String(url), 'processing_url must be an absolute URL').toMatch(/^https?:\/\//);
  const ctx = await apiRequest.newContext();
  const page = await ctx.get(url); const code = page.status(); await ctx.dispose();
  console.log(`S14: checkout GET=${code}`);
  expect(code, 'checkout page did not load').toBeLessThan(400);
});
