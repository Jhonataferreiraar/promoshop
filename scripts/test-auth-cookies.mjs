import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-auth-cookies-'));
const previous = {
  NODE_ENV: process.env.NODE_ENV,
  DATA_DIR: process.env.DATA_DIR,
  AUTH_SECRET: process.env.AUTH_SECRET
};

try {
  process.env.NODE_ENV = 'production';
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_SECRET = 'auth-cookie-test-secret-with-more-than-32-characters';
  const auth = await import(`../server/auth.js?production-cookies=${Date.now()}`);
  const headers = [];
  const response = { append(name, value) { if (name === 'Set-Cookie') headers.push(value); } };
  const token = auth.createToken('admin', 2);
  auth.setSessionCookies(response, token);

  assert.ok(headers.some((value) => value.startsWith('__Host-promoshop_session=') && /; Secure(?:;|$)/.test(value) && /; HttpOnly(?:;|$)/.test(value)));
  assert.ok(headers.some((value) => value.startsWith('__Host-promoshop_csrf=') && /; Secure(?:;|$)/.test(value)));
  assert.ok(headers.some((value) => value.startsWith('promoshop_session=') && /Max-Age=0/.test(value)));
  assert.equal(auth.validateToken(token, 2), true);
  assert.equal(auth.validateToken(token, 3), false);
  console.log('Sessão: cookies __Host, Secure, HttpOnly, CSRF e versão validados.');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
}
