import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-extension-'));
const port = 33000 + Math.floor(Math.random() * 500);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'SenhaInicialSegura123!', AUTH_SECRET: 'extension-test-secret-long-and-random', SITE_URL: origin, WHATSAPP_AUTOSTART: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste não iniciou.');
}

try {
  await waitForServer();
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'SenhaInicialSegura123!' }) });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(Object.hasOwn(loginBody, 'token'), false);
  const setCookies = login.headers.getSetCookie?.() || [];
  const cookieHeader = setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  const csrfToken = decodeURIComponent(cookieHeader.match(/(?:^|; )promoshop_csrf=([^;]+)/)?.[1] || '');
  const adminHeaders = { cookie: cookieHeader, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
  const tokenResponse = await fetch(`${origin}/api/admin/extension/token`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json();
  assert.ok(token.length >= 40);

  const ingest = await fetch(`${origin}/api/extension/coupons`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-promoshop-extension-token': token }, body: JSON.stringify({ coupons: [{ title: 'Cupom teste da extensão', store: 'Mercado Livre', code: 'TESTE10', discountType: 'percent', discountValue: 10, link: 'https://mercadolivre.com.br/oferta/teste', targetAudienceCodes: ['G01'] }] }) });
  assert.equal(ingest.status, 202);
  assert.equal((await ingest.clone().json()).acceptedFingerprints.length, 1);
  const dashboard = await fetch(`${origin}/api/admin/dashboard`, { headers: adminHeaders }).then((response) => response.json());
  const coupon = dashboard.coupons.find((entry) => entry.source === 'extension');
  assert.equal(coupon.approvalStatus, 'pending');
  const approved = await fetch(`${origin}/api/admin/extension/coupons/${coupon.id}/approve`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(approved.status, 200);
  const offerIngest = await fetch(`${origin}/api/extension/mercadolivre/offers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-promoshop-extension-token': token }, body: JSON.stringify({ offers: [{ externalId: 'MLB123456789', title: 'Oferta capturada com link oficial', price: 79.9, originalPrice: 129.9, discount: 38, image: 'https://http2.mlstatic.com/D_NQ_NP_123.jpg', productUrl: 'https://www.mercadolivre.com.br/produto/p/MLB123456789', affiliateUrl: 'https://meli.la/abc123', freeShipping: true }] }) });
  assert.equal(offerIngest.status, 202);
  assert.equal((await offerIngest.clone().json()).imported.length, 1);
  const offerRefresh = await fetch(`${origin}/api/extension/mercadolivre/offers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-promoshop-extension-token': token }, body: JSON.stringify({ offers: [{ externalId: 'MLB123456789', title: 'Oferta capturada atualizada', price: 69.9, originalPrice: 129.9, discount: 46, image: 'https://http2.mlstatic.com/D_NQ_NP_123.jpg', productUrl: 'https://www.mercadolivre.com.br/produto/p/MLB123456789', affiliateUrl: 'https://meli.la/xyz456' }] }) });
  assert.equal(offerRefresh.status, 202);
  assert.equal((await offerRefresh.json()).imported[0].updated, true);
  const resend = await fetch(`${origin}/api/extension/coupons`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-promoshop-extension-token': token }, body: JSON.stringify({ allowDuplicate: true, coupons: [{ title: 'Cupom teste da extensão atualizado', store: 'Mercado Livre', code: 'TESTE10', discountType: 'percent', discountValue: 20, link: 'https://mercadolivre.com.br/oferta/teste', targetAudienceCodes: ['G01'] }] }) });
  assert.equal(resend.status, 202);
  assert.equal((await resend.json()).imported[0].reimported, true);
  const secondIngest = await fetch(`${origin}/api/extension/coupons`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-promoshop-extension-token': token }, body: JSON.stringify({ coupons: [{ title: 'Cupom para recusa em lote', store: 'Shopee', code: 'RECUSAR10', discountType: 'percent', discountValue: 10, link: 'https://shopee.com.br/oferta/teste', targetAudienceCodes: ['G01'] }] }) });
  assert.equal(secondIngest.status, 202);
  const rejected = await fetch(`${origin}/api/admin/extension/coupons/reject-all`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).rejected, 2);
  console.log('Extensões: cupons e ofertas do Mercado Livre validados.');
} finally {
  child.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
}
