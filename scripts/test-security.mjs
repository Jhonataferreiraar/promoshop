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
    STORE_BACKEND: 'file',
    ADMIN_PASSWORD: 'SenhaInicialSegura123!',
    AUTH_SECRET: 'security-test-secret-that-is-long-and-random',
    WORKER_TOKEN: 'security-test-worker-token-that-is-long-enough',
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
  const healthBody = await health.json();
  assert.deepEqual(healthBody.services, { database: 'ok' });
  assert.equal(Object.hasOwn(healthBody, 'ai'), false);
  assert.equal(Object.hasOwn(healthBody, 'storage'), false);

  const publicHomeResponse = await fetch(`${origin}/api/home`);
  assert.equal(publicHomeResponse.status, 200);
  const publicHome = await publicHomeResponse.json();
  assert.equal(publicHome.config.brandName, 'PromoShop');
  assert.ok(Array.isArray(publicHome.coupons));
  assert.ok(Array.isArray(publicHome.audiences));
  assert.equal(publicHome.config.assistantAvailable, true);
  assert.equal(Object.hasOwn(publicHome.config, 'whatsappAudiences'), false);
  assert.equal(Object.hasOwn(publicHome, 'secrets'), false);

  const validLogin = await login('SenhaInicialSegura123!');
  assert.equal(validLogin.status, 200);
  const loginBody = await validLogin.json();
  assert.equal(loginBody.authenticated, true);
  assert.equal(Object.hasOwn(loginBody, 'token'), false);
  const setCookies = validLogin.headers.getSetCookie?.() || [];
  assert.ok(setCookies.some((cookie) => /promoshop_session=.*HttpOnly/i.test(cookie)));
  assert.ok(setCookies.some((cookie) => /promoshop_csrf=.*SameSite=Lax/i.test(cookie)));
  const cookieHeader = setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  const csrfToken = decodeURIComponent(cookieHeader.match(/(?:^|; )promoshop_csrf=([^;]+)/)?.[1] || '');
  assert.ok(csrfToken);
  const authorization = { cookie: cookieHeader, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/admin/dashboard`, { headers: authorization })).status, 200);
  const whatsappStateResponse = await fetch(`${origin}/api/admin/whatsapp/state`, { headers: authorization });
  assert.equal(whatsappStateResponse.status, 200);
  const whatsappState = await whatsappStateResponse.json();
  assert.ok(whatsappState.whatsapp);
  assert.equal(Object.hasOwn(whatsappState, 'offers'), false);
  assert.equal(Object.hasOwn(whatsappState, 'queue'), false);
  const qrWorkerHeaders = {
    'content-type': 'application/json',
    'x-worker-token': 'security-test-worker-token-that-is-long-enough'
  };
  const qrUpdate = await fetch(`${origin}/api/worker/qr`, {
    method: 'POST', headers: qrWorkerHeaders, body: JSON.stringify({ qr: 'temporary-qr-for-security-test' })
  });
  assert.equal(qrUpdate.status, 200);
  const stateWithQr = await fetch(`${origin}/api/admin/whatsapp/state`, { headers: authorization }).then((response) => response.json());
  assert.match(stateWithQr.whatsapp.qrDataUrl || '', /^data:image\/png;base64,/);
  const pairingUpdate = await fetch(`${origin}/api/worker/pairing-code`, {
    method: 'POST', headers: qrWorkerHeaders, body: JSON.stringify({ code: 'ABCD1234' })
  });
  assert.equal(pairingUpdate.status, 200);
  const stateWithPairing = await fetch(`${origin}/api/admin/whatsapp/state`, { headers: authorization }).then((response) => response.json());
  assert.equal(stateWithPairing.whatsapp.pairingCode, 'ABCD1234');
  assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { cookie: cookieHeader } })).status, 200);
  assert.equal((await fetch(`${origin}/api/admin/config`, { method: 'PUT', headers: { cookie: cookieHeader, 'content-type': 'application/json' }, body: JSON.stringify({ brandName: 'PromoShop' }) })).status, 403);
  assert.equal((await fetch(`${origin}/api/admin/config`, { method: 'PUT', headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ brandName: 'PromoShop', __internal: 'blocked' }) })).status, 200);

  const initialDashboard = await fetch(`${origin}/api/admin/dashboard`, { headers: authorization }).then((response) => response.json());
  const technologyAudience = initialDashboard.config.whatsappAudiences.find((audience) => audience.code === 'G02');
  technologyAudience.keywords = ['notebook', ' Notebook ', 'ultrabook', 'fone bluetooth'];
  technologyAudience.blockedKeywords = ['usado', ' USADO '];
  technologyAudience.whatsappLink = 'https://chat.whatsapp.com/grupo-promoshop-teste';
  const keywordSave = await fetch(`${origin}/api/admin/config`, {
    method: 'PUT',
    headers: authorization,
    body: JSON.stringify({ whatsappAudiences: initialDashboard.config.whatsappAudiences })
  });
  assert.equal(keywordSave.status, 200);
  const dashboardWithKeywords = await fetch(`${origin}/api/admin/dashboard`, { headers: authorization }).then((response) => response.json());
  const savedTechnologyAudience = dashboardWithKeywords.config.whatsappAudiences.find((audience) => audience.code === 'G02');
  assert.deepEqual(savedTechnologyAudience.keywords, ['notebook', 'ultrabook', 'fone bluetooth']);
  assert.deepEqual(savedTechnologyAudience.blockedKeywords, ['usado']);

  const originalPublishingStart = dashboardWithKeywords.config.publishingStart;
  const invalidClockSave = await fetch(`${origin}/api/admin/config`, {
    method: 'PUT',
    headers: authorization,
    body: JSON.stringify({ publishingStart: '29:90' })
  });
  assert.equal(invalidClockSave.status, 200);
  const dashboardAfterInvalidClock = await fetch(`${origin}/api/admin/dashboard`, { headers: authorization }).then((response) => response.json());
  assert.equal(dashboardAfterInvalidClock.config.publishingStart, originalPublishingStart);

  const receiptId = 'privacyreceipt1234567890';
  const currentPolicyVersion = (await fetch(`${origin}/api/config/public`).then((response) => response.json())).legalPolicyVersion;
  const privacyReceipt = await fetch(`${origin}/api/privacy/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, choice: 'accepted', policyVersion: currentPolicyVersion })
  });
  assert.equal(privacyReceipt.status, 200);
  const dashboardWithReceipt = await fetch(`${origin}/api/admin/dashboard`, { headers: authorization }).then((response) => response.json());
  assert.equal(Object.hasOwn(dashboardWithReceipt, 'privacyConsents'), false);
  assert.equal(Object.hasOwn(dashboardWithReceipt.meta || {}, 'whatsappSentSourceLedger'), false);

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
  const persistedStore = JSON.parse(await fs.readFile(path.join(testDataDir, 'db.json'), 'utf8'));
  assert.equal(persistedStore.privacyConsents.__encrypted, 'aes-256-gcm-v1');
  assert.equal(persistedStore.inbox.__encrypted, 'aes-256-gcm-v1');
  assert.equal(persistedStore.analytics.visitors.__encrypted, 'aes-256-gcm-v1');

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
    body: JSON.stringify({ title: 'Fone Bluetooth Teste Premium', store: 'AliExpress', category: 'Tecnologia', price: 99.9, originalPrice: 199.9, image: 'https://ae-pic-a1.aliexpress-media.com/fone.jpg', affiliateUrl: 'https://www.aliexpress.com/item/1005000000000.html', freeShipping: true, status: 'active' })
  });
  assert.equal(createdOfferResponse.status, 201);
  const createdOffer = await createdOfferResponse.json();
  const publicOffers = await fetch(`${origin}/api/offers?paged=1&sort=smart`).then((response) => response.json());
  assert.equal(publicOffers.total, 1);
  assert.equal(publicOffers.categories[0], 'Tecnologia');
  assert.match(publicOffers.offers[0].publicSlug, /fone-bluetooth/);
  assert.equal(Object.hasOwn(publicOffers.offers[0], 'targetAudienceCodes'), false);
  assert.equal(Object.hasOwn(publicOffers.offers[0], 'source'), false);
  const productPage = await fetch(`${origin}/api/offer/${publicOffers.offers[0].publicSlug}`).then((response) => response.json());
  assert.equal(productPage.offer.title, 'Fone Bluetooth Teste Premium');

  const queuedResponse = await fetch(`${origin}/api/admin/offers/${createdOffer.id}/queue`, {
    method: 'POST', headers: authorization, body: JSON.stringify({ force: true })
  });
  assert.equal(queuedResponse.status, 201);
  const queuedItem = await queuedResponse.json();
  const workerHeaders = {
    'content-type': 'application/json',
    'x-worker-token': 'security-test-worker-token-that-is-long-enough'
  };
  const workerPost = (route, body) => fetch(`${origin}${route}`, {
    method: 'POST', headers: workerHeaders, body: JSON.stringify(body)
  });
  assert.equal((await workerPost(`/api/worker/queue/${queuedItem.id}/destination/claim`, { destinationId: 'group-1', destinationName: 'Grupo 1' })).status, 200);
  assert.equal((await workerPost(`/api/worker/queue/${queuedItem.id}/destination/started`, { destinationId: 'group-1' })).status, 200);
  assert.equal((await workerPost(`/api/worker/queue/${queuedItem.id}/destination/complete`, { destinationId: 'group-1', destinationName: 'Grupo 1' })).status, 200);
  assert.equal((await workerPost(`/api/worker/queue/${queuedItem.id}/destination/claim`, { destinationId: 'channel-1', destinationName: 'Canal 1' })).status, 200);
  assert.equal((await workerPost(`/api/worker/queue/${queuedItem.id}/destination/release`, { destinationId: 'channel-1' })).status, 200);
  assert.equal((await workerPost(`/api/worker/queue/${queuedItem.id}/fail`, { error: 'Canal indisponível antes do envio', retrySafe: true })).status, 200);
  const deliveryStore = JSON.parse(await fs.readFile(path.join(testDataDir, 'db.json'), 'utf8'));
  const partialQueueItem = deliveryStore.queue.find((item) => item.id === queuedItem.id);
  assert.equal(partialQueueItem.status, 'pending');
  assert.deepEqual(partialQueueItem.deliverySentDestinationIds, ['group-1']);
  const completedClaim = await workerPost(`/api/worker/queue/${queuedItem.id}/destination/claim`, { destinationId: 'group-1', destinationName: 'Grupo 1' }).then((response) => response.json());
  assert.equal(completedClaim.claimed, false);
  assert.equal(completedClaim.alreadyClaimed, true);
  const missingClaim = await workerPost(`/api/worker/queue/${queuedItem.id}/destination/claim`, { destinationId: 'channel-1', destinationName: 'Canal 1' }).then((response) => response.json());
  assert.equal(missingClaim.claimed, true);

  const assistantQuestion = await fetch(`${origin}/api/assistant/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Quero um fone bluetooth' })
  }).then((response) => response.json());
  assert.equal(assistantQuestion.status, 'question');
  assert.equal(assistantQuestion.products.length, 0);
  assert.equal(assistantQuestion.audiences[0].code, 'G02');

  const assistantGroups = await fetch(`${origin}/api/assistant/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Gosto de maquiagem, perfumes e produtos pet' })
  }).then((response) => response.json());
  assert.equal(assistantGroups.status, 'result');
  assert.equal(assistantGroups.products.length, 0);
  assert.equal(assistantGroups.audiences.some((audience) => audience.code === 'G04'), true);
  assert.equal(assistantGroups.audiences.some((audience) => audience.code === 'G06'), true);

  const assistantResult = await fetch(`${origin}/api/assistant/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: '200',
      history: [
        { role: 'user', content: 'Quero um fone bluetooth' },
        { role: 'assistant', content: 'Qual é o seu orçamento?' }
      ]
    })
  }).then((response) => response.json());
  assert.equal(assistantResult.status, 'result');
  assert.equal(assistantResult.products[0].title, 'Fone Bluetooth Teste Premium');
  assert.equal(assistantResult.audiences[0].code, 'G02');

  const assistantThanks = await fetch(`${origin}/api/assistant/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'Obrigado!',
      history: [
        { role: 'user', content: 'Quero um fone bluetooth' },
        { role: 'assistant', content: assistantQuestion.message },
        { role: 'user', content: '200' },
        { role: 'assistant', content: assistantResult.message }
      ],
      seenProductIds: assistantResult.products.map((product) => product.id)
    })
  }).then((response) => response.json());
  assert.equal(assistantThanks.status, 'chat');
  assert.equal(assistantThanks.products.length, 0);
  assert.equal(assistantThanks.audiences.length, 0);
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
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await fs.rm(testDataDir, { recursive: true, force: true });
}
