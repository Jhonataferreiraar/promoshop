const STATE_COLUMNS = Object.freeze({
  config: 'config',
  offers: 'offers',
  coupons: 'coupons',
  inbox: 'inbox',
  privacyConsents: 'privacy_consents',
  queue: 'queue',
  instagramQueue: 'instagram_queue',
  instagramFeedQueue: 'instagram_feed_queue',
  logs: 'logs',
  analytics: 'analytics',
  meta: 'meta'
});

const STATE_KEYS = Object.keys(STATE_COLUMNS);
const CACHE_REVALIDATE_MS = 750;
const OFFER_TABLE = 'promoshop_offers';
const POSTGRES_SCHEMA_VERSION = 2;
const SECTION_TABLE = 'promoshop_sections';
const SECTION_KEYS = Object.freeze([
  'config',
  'inbox',
  'privacyConsents',
  'analytics',
  'meta'
]);
const ENTITY_TABLES = Object.freeze({
  coupons: 'promoshop_coupons',
  queue: 'promoshop_queue',
  instagramQueue: 'promoshop_instagram_queue',
  instagramFeedQueue: 'promoshop_instagram_feed_queue',
  logs: 'promoshop_logs'
});

function serialize(value) {
  return JSON.stringify(value ?? null);
}

function rowToPersistedData(row) {
  return Object.fromEntries(
    STATE_KEYS.map((key) => [key, row[STATE_COLUMNS[key]]])
  );
}

function offerTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function offerNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function ensureOfferTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${OFFER_TABLE} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      store TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      price NUMERIC,
      original_price NUMERIC,
      affiliate_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      position BIGINT NOT NULL DEFAULT 0,
      data JSONB NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${OFFER_TABLE} ADD COLUMN IF NOT EXISTS position BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${OFFER_TABLE}_status_idx ON ${OFFER_TABLE} (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${OFFER_TABLE}_category_idx ON ${OFFER_TABLE} (category)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${OFFER_TABLE}_updated_idx ON ${OFFER_TABLE} (updated_at DESC)`);
}

async function ensureRelationalTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SECTION_TABLE} (
      section TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const table of Object.values(ENTITY_TABLES)) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        position BIGINT NOT NULL DEFAULT 0,
        data JSONB NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_position_idx ON ${table} (position, id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_status_idx ON ${table} ((data->>'status'))`);
  }

  await pool.query(`CREATE INDEX IF NOT EXISTS promoshop_coupons_active_idx ON promoshop_coupons ((data->>'active'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS promoshop_queue_created_idx ON promoshop_queue ((data->>'createdAt'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS promoshop_logs_created_idx ON promoshop_logs ((data->>'createdAt'))`);
}

function entityRows(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item, position) => {
    const id = String(item?.id || '').trim().slice(0, 240);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, position, data: item }];
  });
}

async function syncJsonEntityTable(executor, table, items) {
  const rows = entityRows(items);
  await executor.query(`
    WITH incoming AS (
      SELECT
        value->>'id' AS id,
        (ordinality - 1)::BIGINT AS position,
        value AS data
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY
      WHERE NULLIF(BTRIM(value->>'id'), '') IS NOT NULL
    ), upserted AS (
      INSERT INTO ${table} (id, position, data, synced_at)
      SELECT id, position, data, NOW() FROM incoming
      ON CONFLICT (id) DO UPDATE SET
        position = EXCLUDED.position,
        data = EXCLUDED.data,
        synced_at = NOW()
      WHERE ${table}.position IS DISTINCT FROM EXCLUDED.position
         OR ${table}.data IS DISTINCT FROM EXCLUDED.data
      RETURNING id
    )
    DELETE FROM ${table} current
    WHERE NOT EXISTS (SELECT 1 FROM incoming WHERE incoming.id = current.id)
  `, [serialize(rows.map((row) => ({ ...row.data, id: row.id })))]);
}

async function syncSections(executor, protectedData, changedKeys = SECTION_KEYS) {
  const keys = SECTION_KEYS.filter((key) => changedKeys.includes(key));
  if (!keys.length) return;
  const values = [];
  const placeholders = keys.map((key, index) => {
    values.push(key, serialize(protectedData[key]));
    const base = index * 2;
    return `($${base + 1}, $${base + 2}::jsonb)`;
  }).join(', ');
  await executor.query(`
    INSERT INTO ${SECTION_TABLE} (section, data)
    VALUES ${placeholders}
    ON CONFLICT (section) DO UPDATE SET
      data = EXCLUDED.data,
      synced_at = NOW()
    WHERE ${SECTION_TABLE}.data IS DISTINCT FROM EXCLUDED.data
  `, values);
}

function emptyPersistedState() {
  return {
    config: {},
    offers: [],
    coupons: [],
    inbox: [],
    privacyConsents: {},
    queue: [],
    instagramQueue: [],
    instagramFeedQueue: [],
    logs: [],
    analytics: { visitors: {} },
    meta: {}
  };
}

function collectionQuery(entries) {
  return entries.map(([key, table]) => `
    SELECT '${key}' AS key,
      COALESCE(jsonb_agg(data ORDER BY position ASC, id ASC), '[]'::jsonb) AS data
    FROM ${table}
  `).join(' UNION ALL ');
}

async function readRelationalPersistedData(executor) {
  const persisted = emptyPersistedState();
  const sections = await executor.query(`SELECT section, data FROM ${SECTION_TABLE}`);
  for (const row of sections.rows) {
    if (SECTION_KEYS.includes(row.section)) persisted[row.section] = row.data;
  }

  const collections = await executor.query(collectionQuery([
    ['offers', OFFER_TABLE],
    ...Object.entries(ENTITY_TABLES)
  ]));
  for (const row of collections.rows) {
    if (row.key === 'offers' || Object.hasOwn(ENTITY_TABLES, row.key)) {
      persisted[row.key] = Array.isArray(row.data) ? row.data : [];
    }
  }
  return persisted;
}

async function readRelationalKeys(executor, keys) {
  const persisted = emptyPersistedState();
  const sectionKeys = keys.filter((key) => SECTION_KEYS.includes(key));
  if (sectionKeys.length) {
    const sections = await executor.query(
      `SELECT section, data FROM ${SECTION_TABLE} WHERE section = ANY($1::text[])`,
      [sectionKeys]
    );
    for (const row of sections.rows) persisted[row.section] = row.data;
  }

  const entityEntries = [];
  if (keys.includes('offers')) entityEntries.push(['offers', OFFER_TABLE]);
  for (const [key, table] of Object.entries(ENTITY_TABLES)) {
    if (keys.includes(key)) entityEntries.push([key, table]);
  }
  if (entityEntries.length) {
    const collections = await executor.query(collectionQuery(entityEntries));
    for (const row of collections.rows) persisted[row.key] = Array.isArray(row.data) ? row.data : [];
  }
  return persisted;
}

async function syncOfferTable(executor, offers) {
  const normalizedOffers = (Array.isArray(offers) ? offers : [])
    .filter((offer) => offer && String(offer.id || '').trim())
    .map((offer) => ({
      id: String(offer.id).trim().slice(0, 200),
      title: String(offer.title || '').slice(0, 500),
      status: String(offer.status || 'active').slice(0, 40),
      store: String(offer.store || '').slice(0, 120),
      category: String(offer.category || '').slice(0, 160),
      price: offerNumber(offer.price),
      originalPrice: offerNumber(offer.originalPrice),
      affiliateUrl: String(offer.affiliateUrl || '').slice(0, 4000),
      createdAt: offerTimestamp(offer.createdAt),
      updatedAt: offerTimestamp(offer.updatedAt),
      data: offer
    }));

  for (let offset = 0; offset < normalizedOffers.length; offset += 100) {
    const batch = normalizedOffers.slice(offset, offset + 100);
    const values = [];
    const placeholders = batch.map((offer, index) => {
      const base = index * 12;
      values.push(
        offer.id,
        offer.title,
        offer.status,
        offer.store,
        offer.category,
        offer.price,
        offer.originalPrice,
        offer.affiliateUrl,
        offer.createdAt,
        offer.updatedAt,
        offset + index,
        serialize(offer.data)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}::jsonb)`;
    }).join(', ');
    await executor.query(
      `INSERT INTO ${OFFER_TABLE} (id, title, status, store, category, price, original_price, affiliate_url, created_at, updated_at, position, data)
       VALUES ${placeholders}
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         store = EXCLUDED.store,
         category = EXCLUDED.category,
         price = EXCLUDED.price,
         original_price = EXCLUDED.original_price,
         affiliate_url = EXCLUDED.affiliate_url,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         position = EXCLUDED.position,
         data = EXCLUDED.data,
         synced_at = NOW()`,
      values
    );
  }

  const ids = normalizedOffers.map((offer) => offer.id);
  if (ids.length) {
    await executor.query(`DELETE FROM ${OFFER_TABLE} WHERE NOT (id = ANY($1::text[]))`, [ids]);
  } else {
    await executor.query(`DELETE FROM ${OFFER_TABLE}`);
  }
}

function isLocalDatabase(connectionString) {
  try {
    const hostname = new URL(connectionString).hostname;
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

export function createPostgresStateBackend({
  connectionString,
  loadInitialData,
  normalizeData,
  restoreData,
  protectData,
  compactData,
  pool: suppliedPool = null
}) {
  let poolPromise = suppliedPool ? Promise.resolve(suppliedPool) : null;
  let ensurePromise = null;
  let writeChain = Promise.resolve();
  let cachedData = null;
  let cachedVersion = -1;
  let lastVersionCheckAt = 0;
  let versionCheckPromise = null;
  let dataLoadPromise = null;
  let connected = false;
  let relationalReady = false;
  const sliceCache = new Map();

  async function getPool() {
    if (!poolPromise) {
      poolPromise = import('pg').then(({ Pool }) => new Pool({
        connectionString,
        max: Math.max(2, Math.min(10, Number(process.env.PG_POOL_MAX) || 5)),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        query_timeout: 15_000,
        statement_timeout: 15_000,
        keepAlive: true,
        ssl: process.env.PGSSL === 'disable' || isLocalDatabase(connectionString)
          ? false
          : { rejectUnauthorized: false }
      }));
    }
    return poolPromise;
  }

  async function ensureDatabase() {
    if (!ensurePromise) {
      ensurePromise = (async () => {
        const pool = await getPool();
        await pool.query(`
          CREATE TABLE IF NOT EXISTS promoshop_state (
            id SMALLINT PRIMARY KEY CHECK (id = 1),
            schema_version INTEGER NOT NULL DEFAULT 1,
            version BIGINT NOT NULL DEFAULT 1,
            config JSONB NOT NULL,
            offers JSONB NOT NULL,
            coupons JSONB NOT NULL,
            inbox JSONB NOT NULL,
            privacy_consents JSONB NOT NULL,
            queue JSONB NOT NULL,
            instagram_queue JSONB NOT NULL,
            instagram_feed_queue JSONB NOT NULL,
            logs JSONB NOT NULL,
            analytics JSONB NOT NULL,
            meta JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query('ALTER TABLE promoshop_state ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1');

        const existing = await pool.query('SELECT version, schema_version FROM promoshop_state WHERE id = 1');
        if (!existing.rowCount) {
          const initial = normalizeData(await loadInitialData());
          const protectedData = await protectData(initial);
          const values = STATE_KEYS.map((key) => serialize(protectedData[key]));
          const columns = STATE_KEYS.map((key) => STATE_COLUMNS[key]).join(', ');
          const parameters = STATE_KEYS.map((_, index) => `$${index + 1}::jsonb`).join(', ');
          await pool.query(
            `INSERT INTO promoshop_state (id, ${columns}) VALUES (1, ${parameters}) ON CONFLICT (id) DO NOTHING`,
            values
          );
        }
        const current = await pool.query('SELECT * FROM promoshop_state WHERE id = 1');
        if (!current.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');
        const row = current.rows[0];
        const wasRelational = Number(row.schema_version || 1) >= POSTGRES_SCHEMA_VERSION;
        try {
          await ensureOfferTable(pool);
          await ensureRelationalTables(pool);
          if (Number(row.schema_version || 1) < POSTGRES_SCHEMA_VERSION) {
            const restored = await restoreData(rowToPersistedData(row));
            const initial = normalizeData(restored.data);
            const protectedData = await protectData(initial);
            await syncOfferTable(pool, initial.offers);
            for (const [key, table] of Object.entries(ENTITY_TABLES)) {
              await syncJsonEntityTable(pool, table, initial[key]);
            }
            await syncSections(pool, protectedData);
            await pool.query(
              'UPDATE promoshop_state SET schema_version = $1, updated_at = NOW() WHERE id = 1',
              [POSTGRES_SCHEMA_VERSION]
            );
          }
          relationalReady = true;
          console.log(`PostgreSQL relacional pronto (schema ${POSTGRES_SCHEMA_VERSION}).`);
        } catch (migrationError) {
          relationalReady = false;
          if (wasRelational) throw migrationError;
          console.error(`Migração relacional adiada; o estado compatível continuará ativo: ${migrationError.message}`);
        }
        connected = true;
      })().catch((error) => {
        ensurePromise = null;
        connected = false;
        throw new Error(`Não foi possível inicializar o PostgreSQL: ${error.message}`, { cause: error });
      });
    }
    return ensurePromise;
  }

  async function loadVersion() {
    const pool = await getPool();
    const result = await pool.query('SELECT version FROM promoshop_state WHERE id = 1');
    if (!result.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');
    connected = true;
    return Number(result.rows[0].version);
  }

  async function loadCurrentData() {
    const pool = await getPool();
    const result = await pool.query(relationalReady
      ? 'SELECT version, schema_version FROM promoshop_state WHERE id = 1'
      : 'SELECT * FROM promoshop_state WHERE id = 1');
    if (!result.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');
    const row = result.rows[0];
    const persisted = relationalReady && Number(row.schema_version || 1) >= POSTGRES_SCHEMA_VERSION
      ? await readRelationalPersistedData(pool)
      : rowToPersistedData(row);
    const restored = await restoreData(persisted);
    const loadedData = normalizeData(restored.data);
    const loadedVersion = Number(row.version);
    // Uma leitura iniciada antes de uma gravação não pode substituir o cache
    // mais novo quando terminar depois dela.
    if (loadedVersion >= cachedVersion) {
      cachedData = loadedData;
      cachedVersion = loadedVersion;
      lastVersionCheckAt = Date.now();
    }
    connected = true;
    return loadedData;
  }

  async function loadCurrentDataOnce() {
    if (!dataLoadPromise) {
      dataLoadPromise = loadCurrentData().finally(() => { dataLoadPromise = null; });
    }
    return dataLoadPromise;
  }

  async function read() {
    await ensureDatabase();
    if (cachedData && Date.now() - lastVersionCheckAt < CACHE_REVALIDATE_MS) return cachedData;
    if (!versionCheckPromise) {
      versionCheckPromise = loadVersion().finally(() => { versionCheckPromise = null; });
    }
    const version = await versionCheckPromise;
    lastVersionCheckAt = Date.now();
    if (cachedData && version === cachedVersion) return cachedData;
    return loadCurrentDataOnce();
  }

  async function readKeys(requestedKeys = []) {
    const keys = [...new Set(requestedKeys)].filter((key) => STATE_KEYS.includes(key)).sort();
    await ensureDatabase();
    if (!keys.length || keys.length === STATE_KEYS.length || !relationalReady) {
      const data = await read();
      return Object.fromEntries(keys.map((key) => [key, data[key]]));
    }
    const cacheKey = keys.join('|');
    const cached = sliceCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < CACHE_REVALIDATE_MS) return cached.data;
    const version = await loadVersion();
    if (cached && cached.version === version) {
      cached.checkedAt = Date.now();
      return cached.data;
    }

    const pool = await getPool();
    const persisted = await readRelationalKeys(pool, keys);
    const restored = await restoreData(persisted);
    const normalized = normalizeData(restored.data);
    const result = Object.fromEntries(keys.map((key) => [key, normalized[key]]));
    sliceCache.set(cacheKey, { data: result, version, checkedAt: Date.now() });
    return result;
  }

  async function update(mutator) {
    writeChain = writeChain.catch(() => {}).then(async () => {
      await ensureDatabase();
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(relationalReady
          ? 'SELECT version, schema_version FROM promoshop_state WHERE id = 1 FOR UPDATE'
          : 'SELECT * FROM promoshop_state WHERE id = 1 FOR UPDATE');
        if (!result.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');

        const row = result.rows[0];
        const useRelationalStore = relationalReady && Number(row.schema_version || 1) >= POSTGRES_SCHEMA_VERSION;
        const persistedBefore = useRelationalStore
          ? await readRelationalPersistedData(client)
          : rowToPersistedData(row);
        const restored = await restoreData(structuredClone(persistedBefore));
        const before = normalizeData(restored.data);
        const data = structuredClone(before);
        const mutatorResult = await mutator(data);
        compactData(data);

        const changedKeys = STATE_KEYS.filter((key) => serialize(before[key]) !== serialize(data[key]));
        if (changedKeys.length) {
          const protectedAfter = await protectData(data);
          if (useRelationalStore) {
            if (changedKeys.includes('offers')) await syncOfferTable(client, data.offers);
            for (const [key, table] of Object.entries(ENTITY_TABLES)) {
              if (changedKeys.includes(key)) await syncJsonEntityTable(client, table, data[key]);
            }
            await syncSections(client, protectedAfter, changedKeys);
          }
          let updated;
          if (useRelationalStore) {
            updated = await client.query(
              'UPDATE promoshop_state SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version'
            );
          } else {
            const assignments = changedKeys.map((key, index) => `${STATE_COLUMNS[key]} = $${index + 1}::jsonb`);
            const values = changedKeys.map((key) => serialize(protectedAfter[key]));
            updated = await client.query(
              `UPDATE promoshop_state SET ${assignments.join(', ')}, version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version`,
              values
            );
          }
          cachedVersion = Number(updated.rows[0].version);
        } else {
          cachedVersion = Number(row.version);
        }

        await client.query('COMMIT');
        cachedData = data;
        sliceCache.clear();
        lastVersionCheckAt = Date.now();
        connected = true;
        return mutatorResult;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        connected = false;
        throw error;
      } finally {
        client.release();
      }
    });
    return writeChain;
  }

  function status() {
    return {
      backend: 'postgres',
      configured: true,
      connected,
      schemaVersion: relationalReady ? POSTGRES_SCHEMA_VERSION : 1,
      cachedVersion: cachedVersion >= 0 ? cachedVersion : null
    };
  }

  async function check() {
    try {
      await ensureDatabase();
      const pool = await getPool();
      await pool.query({ text: 'SELECT 1', query_timeout: 2_000 });
      connected = true;
      return true;
    } catch {
      connected = false;
      return false;
    }
  }

  return { read, readKeys, update, status, check };
}
