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
  offerRows = new Map();
  sections = new Map();
  entityRows = new Map([
    ['promoshop_coupons', new Map()],
    ['promoshop_queue', new Map()],
    ['promoshop_instagram_queue', new Map()],
    ['promoshop_instagram_feed_queue', new Map()],
    ['promoshop_logs', new Map()]
  ]);

  async query(sql, values = []) {
    const queryText = typeof sql === 'object' ? sql.text : sql;
    const normalized = queryText.replace(/\s+/g, ' ').trim();
    if (/^SELECT 1$/i.test(normalized)) return { rowCount: 1, rows: [{ '?column?': 1 }] };
    if (/^CREATE TABLE/i.test(normalized)) return { rowCount: 0, rows: [] };
    if (/^CREATE INDEX/i.test(normalized)) return { rowCount: 0, rows: [] };
    if (/^ALTER TABLE/i.test(normalized)) return { rowCount: 0, rows: [] };
    if (/^SELECT version(?:, schema_version)? FROM/i.test(normalized)) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [{ version: this.row.version, schema_version: this.row.schema_version }] : [] };
    }
    if (/^INSERT INTO promoshop_sections/i.test(normalized)) {
      for (let index = 0; index < values.length; index += 2) this.sections.set(values[index], JSON.parse(values[index + 1]));
      return { rowCount: values.length / 2, rows: [] };
    }
    if (/^WITH incoming AS/i.test(normalized)) {
      const table = normalized.match(/INSERT INTO (promoshop_[a-z_]+)/i)?.[1];
      const target = this.entityRows.get(table);
      if (!target) throw new Error(`Tabela inesperada no teste: ${table}`);
      const items = JSON.parse(values[0]);
      target.clear();
      items.forEach((item, position) => target.set(String(item.id), { data: structuredClone(item), position }));
      return { rowCount: items.length, rows: [] };
    }
    if (/^INSERT INTO/i.test(normalized)) {
      if (/promoshop_offers/i.test(normalized)) {
        for (let index = 0; index < values.length; index += 12) {
          this.offerRows.set(String(values[index]), { data: JSON.parse(values[index + 11]), position: Number(values[index + 10]) });
        }
        return { rowCount: 1, rows: [] };
      }
      if (!this.row) {
        this.row = { id: 1, version: 1, schema_version: 1 };
        stateKeys.forEach((key, index) => { this.row[columns[key]] = JSON.parse(values[index]); });
      }
      return { rowCount: 1, rows: [] };
    }
    if (/^DELETE FROM promoshop_offers/i.test(normalized)) {
      if (Array.isArray(values[0])) {
        const keep = new Set(values[0].map(String));
        for (const id of this.offerRows.keys()) if (!keep.has(id)) this.offerRows.delete(id);
      } else {
        this.offerRows.clear();
      }
      return { rowCount: 0, rows: [] };
    }
    if (/^SELECT section, data FROM promoshop_sections/i.test(normalized)) {
      return { rowCount: this.sections.size, rows: [...this.sections].map(([section, data]) => ({ section, data: structuredClone(data) })) };
    }
    if (/^SELECT '[^']+' AS key/i.test(normalized)) {
      const rows = [];
      if (normalized.includes("SELECT 'offers' AS key")) {
        rows.push({
          key: 'offers',
          data: [...this.offerRows.values()].sort((a, b) => a.position - b.position).map((entry) => structuredClone(entry.data))
        });
      }
      for (const [table, entries] of this.entityRows) {
        const key = Object.entries({
          coupons: 'promoshop_coupons',
          queue: 'promoshop_queue',
          instagramQueue: 'promoshop_instagram_queue',
          instagramFeedQueue: 'promoshop_instagram_feed_queue',
          logs: 'promoshop_logs'
        }).find(([, value]) => value === table)?.[0];
        if (normalized.includes(`SELECT '${key}' AS key`)) {
          rows.push({ key, data: [...entries.values()].sort((a, b) => a.position - b.position).map((entry) => structuredClone(entry.data)) });
        }
      }
      return { rowCount: rows.length, rows };
    }
    if (/^SELECT data FROM promoshop_offers/i.test(normalized)) {
      const rows = [...this.offerRows.values()].sort((a, b) => a.position - b.position).map((entry) => ({ data: structuredClone(entry.data) }));
      return { rowCount: rows.length, rows };
    }
    if (/^SELECT data FROM promoshop_[a-z_]+/i.test(normalized)) {
      const table = normalized.match(/^SELECT data FROM (promoshop_[a-z_]+)/i)?.[1];
      const rows = [...(this.entityRows.get(table)?.values() || [])].sort((a, b) => a.position - b.position).map((entry) => ({ data: structuredClone(entry.data) }));
      return { rowCount: rows.length, rows };
    }
    if (/^SELECT \* FROM/i.test(normalized)) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [structuredClone(this.row)] : [] };
    }
    if (/^UPDATE promoshop_state SET schema_version/i.test(normalized)) {
      this.row.schema_version = Number(values[0]);
      return { rowCount: 1, rows: [] };
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
assert.equal(pool.row.offers.length, 0);
assert.equal(pool.row.version, 2);
assert.equal(pool.offerRows.has('offer-1'), true);
assert.equal(pool.row.schema_version, 2);
assert.equal(pool.sections.get('config').brandName, 'PromoShop');

// A partir da versão 2, as tabelas relacionais são a fonte principal. O
// espelho legado pode estar desatualizado sem alterar a leitura do sistema.
pool.row.offers = [];
pool.row.config = { brandName: 'Espelho antigo' };

const secondProcess = createPostgresStateBackend(callbacks);
const shared = await secondProcess.read();
assert.equal(shared.offers[0].title, 'Oferta migrada');
assert.equal(shared.config.brandName, 'PromoShop');

const publicSlice = await secondProcess.readKeys(['config', 'offers']);
assert.equal(publicSlice.offers[0].title, 'Oferta migrada');
assert.equal(publicSlice.config.brandName, 'PromoShop');
assert.deepEqual(await secondProcess.readKeys(['coupons']), { coupons: [] });

await secondProcess.update((data) => {
  data.queue.push({ id: 'queue-1', status: 'pending' });
});
assert.deepEqual(pool.row.queue, []);
assert.equal(pool.entityRows.get('promoshop_queue').get('queue-1').data.status, 'pending');
assert.equal(pool.row.version, 3);

console.log('PostgreSQL: importação inicial, atualização transacional e leitura entre processos validadas.');
