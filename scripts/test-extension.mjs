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
  const { token: adminToken } = await login.json();
  const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const tokenResponse = await fetch(`${origin}/api/admin/extension/token`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json();
  assert.ok(token.length >= 40);

  const ingest = await fetch(`${origin}/api/extension/coupons`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token, coupons: [{ title: 'Cupom teste da extensão', store: 'Mercado Livre', code: 'TESTE10', discountType: 'percent', discountValue: 10, link: 'https://mercadolivre.com.br/oferta/teste', targetAudienceCodes: ['G01'] }] }) });
  assert.equal(ingest.status, 202);
  const dashboard = await fetch(`${origin}/api/admin/dashboard`, { headers: adminHeaders }).then((response) => response.json());
  const coupon = dashboard.coupons.find((entry) => entry.source === 'extension');
  assert.equal(coupon.approvalStatus, 'pending');
  const approved = await fetch(`${origin}/api/admin/extension/coupons/${coupon.id}/approve`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(approved.status, 200);
  console.log('Extensão: token, recebimento, revisão e aprovação validados.');
} finally {
  child.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
}
