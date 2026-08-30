import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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
  const expectedAiCredential = crypto.randomBytes(24).toString('base64url');
  await legacy.updateSecrets({ aiApiKey: expectedAiCredential });
  assert.equal(await fs.stat(path.join(dataDir, '.secret-key')).then(() => true), true);

  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const migrated = await import(`../server/secrets.js?migrated=${Date.now()}`);
  const migratedData = await migrated.readSecrets();
  assert.equal(migratedData.aiApiKey, expectedAiCredential);
  await assert.rejects(fs.stat(path.join(dataDir, '.secret-key')), { code: 'ENOENT' });
  const vaultFileName = ['secrets', 'enc'].join('.');
  const encryptedPayload = await fs.readFile(path.join(dataDir, vaultFileName), 'utf8');
  assert.equal(encryptedPayload.includes(migratedData.aiApiKey), false);

  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const wrongKey = await import(`../server/secrets.js?wrong=${Date.now()}`);
  await assert.rejects(() => wrongKey.readSecrets(), /Não foi possível descriptografar/);
  console.log('Segredos: migração da chave local para a chave externa validada.');
} finally {
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = originalAdminPassword;
  await fs.rm(dataDir, { recursive: true, force: true });
}
