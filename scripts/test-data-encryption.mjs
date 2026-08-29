import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-data-encryption-'));
const originalDataDir = process.env.DATA_DIR;
const originalStoreBackend = process.env.STORE_BACKEND;
const originalEncryptionKey = process.env.DATA_ENCRYPTION_KEY;

try {
  process.env.DATA_DIR = dataDir;
  process.env.STORE_BACKEND = 'file';
  delete process.env.DATA_ENCRYPTION_KEY;

  const legacy = await import(`../server/store.js?legacy-data-key=${Date.now()}`);
  await legacy.updateStore((data) => {
    data.inbox = [{ id: 'private-message', email: 'private@example.test', message: 'conteudo privado' }];
    data.privacyConsents = { receipt: { choice: 'accepted', ipHash: 'private-ip-hash' } };
    data.analytics.visitors = { visitor: { source: 'private-source' } };
  });
  await fs.stat(path.join(dataDir, '.data-key'));

  process.env.DATA_ENCRYPTION_KEY = 'c'.repeat(64);
  const migrated = await import(`../server/store.js?external-data-key=${Date.now()}`);
  const restored = await migrated.readStore();
  assert.equal(restored.inbox[0].email, 'private@example.test');
  assert.equal(restored.privacyConsents.receipt.ipHash, 'private-ip-hash');
  assert.equal(restored.analytics.visitors.visitor.source, 'private-source');
  await assert.rejects(fs.stat(path.join(dataDir, '.data-key')), { code: 'ENOENT' });

  const encryptedSnapshot = await fs.readFile(path.join(dataDir, 'db.json'), 'utf8');
  assert.equal(encryptedSnapshot.includes('private@example.test'), false);
  assert.equal(encryptedSnapshot.includes('private-ip-hash'), false);
  assert.equal(encryptedSnapshot.includes('private-source'), false);

  process.env.DATA_ENCRYPTION_KEY = 'd'.repeat(64);
  const wrongKey = await import(`../server/store.js?wrong-data-key=${Date.now()}`);
  await assert.rejects(() => wrongKey.readStore(), /Não foi possível descriptografar/);
  console.log('Dados pessoais: migração da chave local para a chave externa validada.');
} finally {
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalStoreBackend === undefined) delete process.env.STORE_BACKEND; else process.env.STORE_BACKEND = originalStoreBackend;
  if (originalEncryptionKey === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = originalEncryptionKey;
  await fs.rm(dataDir, { recursive: true, force: true });
}
