import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-secrets-'));
const originalDataDir = process.env.DATA_DIR;
const originalEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
const originalAdminPassword = process.env.ADMIN_PASSWORD;

try {
  process.env.DATA_DIR = dataDir;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.ADMIN_PASSWORD;
  const legacy = await import(`../server/secrets.js?legacy=${Date.now()}`);
  await legacy.readSecrets();
  await legacy.updateSecrets({ aiApiKey: 'REDACTED_GROQ_KEY' });
  assert.equal(await fs.stat(path.join(dataDir, '.secret-key')).then(() => true), true);

  process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
  const migrated = await import(`../server/secrets.js?migrated=${Date.now()}`);
  const migratedSecrets = await migrated.readSecrets();
  assert.equal(migratedSecrets.aiApiKey, 'REDACTED_GROQ_KEY');
  await assert.rejects(fs.stat(path.join(dataDir, '.secret-key')), { code: 'ENOENT' });
  const encryptedPayload = await fs.readFile(path.join(dataDir, 'secrets.enc'), 'utf8');
  assert.equal(encryptedPayload.includes(migratedSecrets.aiApiKey), false);

  process.env.SECRETS_ENCRYPTION_KEY = 'b'.repeat(64);
  const wrongKey = await import(`../server/secrets.js?wrong=${Date.now()}`);
  await assert.rejects(() => wrongKey.readSecrets(), /Não foi possível descriptografar/);
  console.log('Segredos: migração da chave local para a chave externa validada.');
} finally {
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = originalAdminPassword;
  await fs.rm(dataDir, { recursive: true, force: true });
}
