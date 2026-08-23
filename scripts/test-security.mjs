import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-security-'));
const port = 32000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: testDataDir,
    ADMIN_PASSWORD: 'SenhaInicialSegura123!',
    AUTH_SECRET: 'security-test-secret-that-is-long-and-random',
    SITE_URL: origin,
    WHATSAPP_AUTOSTART: 'false',
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste não iniciou.');
}

async function login(password) {
  return fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password })
  });
}

try {
  await waitForServer();
  const health = await fetch(`${origin}/api/health`, { headers: { Origin: 'https://malicioso.example' } });
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.match(health.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const validLogin = await login('SenhaInicialSegura123!');
  assert.equal(validLogin.status, 200);
  const { token } = await validLogin.json();
  const authorization = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/admin/dashboard`, { headers: authorization })).status, 200);

  const receiptId = 'privacyreceipt1234567890';
  const privacyReceipt = await fetch(`${origin}/api/privacy/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, choice: 'accepted', policyVersion: '2026-08-23-v3' })
  });
  assert.equal(privacyReceipt.status, 200);
  const dashboardWithReceipt = await fetch(`${origin}/api/admin/dashboard`, { headers: authorization }).then((response) => response.json());
  assert.equal(dashboardWithReceipt.privacyConsents[receiptId].choice, 'accepted');
  assert.equal(Object.hasOwn(dashboardWithReceipt.privacyConsents[receiptId], 'ip'), false);

  const visitorId = 'anonymousvisitor1234567890';
  const sessionId = 'anonymoussession1234567890';
  const unauthorizedVisit = await fetch(`${origin}/api/analytics/visit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId, sessionId, receiptId: 'unknownreceipt123456789' })
  });
  assert.equal(unauthorizedVisit.status, 403);

  const authorizedVisit = await fetch(`${origin}/api/analytics/visit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId, sessionId, receiptId })
  });
  assert.equal(authorizedVisit.status, 200);

  const clickEvent = await fetch(`${origin}/api/analytics/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, visitorId, sessionId, type: 'offer', targetId: 'offer-test-123456', label: 'Oferta de teste', store: 'Loja de teste' })
  });
  assert.equal(clickEvent.status, 200);
  const analyticsDashboard = await fetch(`${origin}/api/admin/dashboard`, { headers: authorization }).then((response) => response.json());
  assert.equal(analyticsDashboard.analytics.totalClicks, 1);
  assert.equal(analyticsDashboard.analytics.topTargets[0].label, 'Oferta de teste');

  const safeBackup = await fetch(`${origin}/api/admin/backup`, { headers: authorization }).then((response) => response.json());
  assert.equal(safeBackup.kind, 'promoshop-safe-backup');
  assert.equal(Object.hasOwn(safeBackup, 'secrets'), false);
  assert.equal(Object.hasOwn(safeBackup, 'analytics'), false);
  assert.equal(Object.hasOwn(safeBackup, 'inbox'), false);

  const robots = await fetch(`${origin}/robots.txt`).then((response) => response.text());
  assert.match(robots, /Sitemap:/);
  assert.match(robots, /Disallow: \/admin/);
  const sitemap = await fetch(`${origin}/sitemap.xml`).then((response) => response.text());
  assert.match(sitemap, /<urlset/);
  assert.match(sitemap, /\/privacidade/);
  assert.doesNotMatch(sitemap, /\/favoritos/);

  const createdOfferResponse = await fetch(`${origin}/api/admin/offers`, {
    method: 'POST', headers: authorization,
    body: JSON.stringify({ title: 'Fone Bluetooth Teste Premium', store: 'Loja Teste', category: 'Tecnologia', price: 99.9, originalPrice: 199.9, image: 'https://example.com/fone.jpg', affiliateUrl: 'https://example.com/produto', freeShipping: true, status: 'active' })
  });
  assert.equal(createdOfferResponse.status, 201);
  const publicOffers = await fetch(`${origin}/api/offers?paged=1&sort=smart`).then((response) => response.json());
  assert.equal(publicOffers.total, 1);
  assert.equal(publicOffers.categories[0], 'Tecnologia');
  assert.match(publicOffers.offers[0].publicSlug, /fone-bluetooth/);
  const productPage = await fetch(`${origin}/api/offer/${publicOffers.offers[0].publicSlug}`).then((response) => response.json());
  assert.equal(productPage.offer.title, 'Fone Bluetooth Teste Premium');
  const favoritesPage = await fetch(`${origin}/favoritos`).then((response) => response.text());
  assert.match(favoritesPage, /noindex, nofollow/);

  const invalidContact = await fetch(`${origin}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Visitante', email: 'visitante@example.com', message: 'Mensagem sem assunto.' })
  });
  assert.equal(invalidContact.status, 400);

  const passwordChange = await fetch(`${origin}/api/admin/secrets`, {
    method: 'PUT',
    headers: authorization,
    body: JSON.stringify({ adminPassword: 'NovaSenhaSegura456!' })
  });
  assert.equal(passwordChange.status, 200);
  assert.equal((await fetch(`${origin}/api/admin/dashboard`, { headers: authorization })).status, 401);
  assert.equal((await login('NovaSenhaSegura456!')).status, 200);

  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await login('senha-incorreta')).status, 401);
  const blocked = await login('senha-incorreta');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  console.log('Proteções de autenticação e cabeçalhos validadas.');
} finally {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  await fs.rm(testDataDir, { recursive: true, force: true });
}
