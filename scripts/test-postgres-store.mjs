import assert from 'node:assert/strict';

import { createPostgresStateBackend } from '../server/postgresStore.js';

const stateKeys = [
  'config', 'offers', 'coupons', 'inbox', 'privacyConsents', 'queue',
  'instagramQueue', 'instagramFeedQueue', 'logs', 'analytics', 'meta'
];
const columns = {
  config: 'config', offers: 'offers', coupons: 'coupons', inbox: 'inbox',
  privacyConsents: 'privacy_consents', queue: 'queue', instagramQueue: 'instagram_queue',
  instagramFeedQueue: 'instagram_feed_queue', logs: 'logs', analytics: 'analytics', meta: 'meta'
};

class MemoryPool {
  row = null;

  async query(sql, values = []) {
    const queryText = typeof sql === 'object' ? sql.text : sql;
    const normalized = queryText.replace(/\s+/g, ' ').trim();
    if (/^SELECT 1$/i.test(normalized)) return { rowCount: 1, rows: [{ '?column?': 1 }] };
    if (/^CREATE TABLE/i.test(normalized)) return { rowCount: 0, rows: [] };
    if (/^SELECT version FROM/i.test(normalized)) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [{ version: this.row.version }] : [] };
    }
    if (/^INSERT INTO/i.test(normalized)) {
      if (!this.row) {
        this.row = { id: 1, version: 1 };
        stateKeys.forEach((key, index) => { this.row[columns[key]] = JSON.parse(values[index]); });
      }
      return { rowCount: 1, rows: [] };
    }
    if (/^SELECT \* FROM/i.test(normalized)) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [structuredClone(this.row)] : [] };
    }
    if (/^UPDATE promoshop_state/i.test(normalized)) {
      const assignmentText = normalized.match(/^UPDATE promoshop_state SET (.+), version = version \+ 1/i)?.[1] || '';
      const changedColumns = [...assignmentText.matchAll(/([a-z_]+) = \$\d+::jsonb/gi)].map((match) => match[1]);
      changedColumns.forEach((column, index) => { this.row[column] = JSON.parse(values[index]); });
      this.row.version += 1;
      return { rowCount: 1, rows: [{ version: this.row.version }] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rowCount: 0, rows: [] };
    throw new Error(`Consulta inesperada no teste: ${normalized}`);
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

const initialData = Object.fromEntries(stateKeys.map((key) => [key, []]));
initialData.config = { brandName: 'PromoShop' };
initialData.analytics = { visitors: {} };
initialData.meta = { imported: true };
initialData.privacyConsents = {};

const pool = new MemoryPool();
const callbacks = {
  connectionString: 'postgresql://localhost/promoshop-test',
  pool,
  loadInitialData: async () => structuredClone(initialData),
  normalizeData: (data) => data,
  restoreData: async (data) => ({ data, encrypted: true }),
  protectData: async (data) => structuredClone(data),
  compactData: (data) => data
};

const firstProcess = createPostgresStateBackend(callbacks);
const imported = await firstProcess.read();
assert.equal(imported.config.brandName, 'PromoShop');
assert.equal(imported.meta.imported, true);
assert.equal(await firstProcess.check(), true);

await firstProcess.update((data) => {
  data.offers.push({ id: 'offer-1', title: 'Oferta migrada' });
});
assert.equal(pool.row.offers.length, 1);
assert.equal(pool.row.version, 2);

const secondProcess = createPostgresStateBackend(callbacks);
const shared = await secondProcess.read();
assert.equal(shared.offers[0].title, 'Oferta migrada');

await secondProcess.update((data) => {
  data.queue.push({ id: 'queue-1', status: 'pending' });
});
assert.equal(pool.row.queue[0].status, 'pending');
assert.equal(pool.row.version, 3);

console.log('PostgreSQL: importação inicial, atualização transacional e leitura entre processos validadas.');
