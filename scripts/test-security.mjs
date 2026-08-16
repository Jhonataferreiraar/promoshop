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
