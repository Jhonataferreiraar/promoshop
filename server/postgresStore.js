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
  logs: 'promoshop_logs',
  campaigns: 'promoshop_campaigns',
  priceMonitors: 'promoshop_price_monitors'
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

async function ensureRowSecurity(pool) {
  const tables = ['promoshop_state', OFFER_TABLE, SECTION_TABLE, ...Object.values(ENTITY_TABLES)];
  for (const table of tables) {
    await pool.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
    await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await pool.query(`
      DO $policy$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policy
          WHERE polrelid = '${table}'::regclass AND polname = 'promoshop_service_access'
        ) THEN
          EXECUTE format(
            'CREATE POLICY promoshop_service_access ON ${table} TO %I USING (true) WITH CHECK (true)',
            current_user
          );
        END IF;
      END
      $policy$
    `);
  }
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

async function syncJsonEntityTable(executor, table, items, beforeItems = null) {
  const allRows = entityRows(items);
  if (beforeItems === null) {
    await executor.query(`
      WITH incoming AS (
        SELECT value->>'id' AS id, (ordinality - 1)::BIGINT AS position, value AS data
        FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY
        WHERE NULLIF(BTRIM(value->>'id'), '') IS NOT NULL
      ), upserted AS (
        INSERT INTO ${table} (id, position, data, synced_at)
        SELECT id, position, data, NOW() FROM incoming
        ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, data = EXCLUDED.data, synced_at = NOW()
        WHERE ${table}.position IS DISTINCT FROM EXCLUDED.position OR ${table}.data IS DISTINCT FROM EXCLUDED.data
        RETURNING id
      )
      DELETE FROM ${table} current WHERE NOT EXISTS (SELECT 1 FROM incoming WHERE incoming.id = current.id)
    `, [serialize(allRows.map((row) => ({ ...row.data, id: row.id })))]);
    return;
  }
  const beforeRows = beforeItems === null ? null : entityRows(beforeItems);
  const previous = beforeRows === null
    ? null
    : new Map(beforeRows.map((row) => [row.id, `${row.position}\0${serialize(row.data)}`]));
  const rows = previous === null
    ? allRows
    : allRows.filter((row) => previous.get(row.id) !== `${row.position}\0${serialize(row.data)}`);
  const currentIds = new Set(allRows.map((row) => row.id));
  const removedIds = beforeRows === null ? [] : beforeRows.filter((row) => !currentIds.has(row.id)).map((row) => row.id);
  if (rows.length) {
  await executor.query(`
    WITH incoming AS (
      SELECT
        value->>'id' AS id,
        (value->>'__position')::BIGINT AS position,
        value - '__position' AS data
      FROM jsonb_array_elements($1::jsonb) AS incoming_value(value)
      WHERE NULLIF(BTRIM(value->>'id'), '') IS NOT NULL
    )
      INSERT INTO ${table} (id, position, data, synced_at)
      SELECT id, position, data, NOW() FROM incoming
      ON CONFLICT (id) DO UPDATE SET
        position = EXCLUDED.position,
        data = EXCLUDED.data,
        synced_at = NOW()
      WHERE ${table}.position IS DISTINCT FROM EXCLUDED.position
         OR ${table}.data IS DISTINCT FROM EXCLUDED.data
      RETURNING id
  `, [serialize(rows.map((row) => ({ ...row.data, id: row.id, __position: row.position })))]);
  }
  if (removedIds.length) {
    await executor.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [removedIds]);
  }
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
    campaigns: [],
    priceMonitors: [],
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

async function syncOfferTable(executor, offers, beforeOffers = null) {
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

  const previous = beforeOffers === null ? null : new Map(
    (Array.isArray(beforeOffers) ? beforeOffers : [])
      .filter((offer) => offer && String(offer.id || '').trim())
      .map((offer, position) => [String(offer.id).trim().slice(0, 200), `${position}\0${serialize(offer)}`])
  );
  const changedOffers = previous === null
    ? normalizedOffers
    : normalizedOffers.filter((offer, position) => previous.get(offer.id) !== `${position}\0${serialize(offer.data)}`);
  const offerPositions = new Map(normalizedOffers.map((offer, position) => [offer.id, position]));

  for (let offset = 0; offset < changedOffers.length; offset += 100) {
    const batch = changedOffers.slice(offset, offset + 100);
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
        offerPositions.get(offer.id),
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
  if (beforeOffers === null) {
    if (ids.length) await executor.query(`DELETE FROM ${OFFER_TABLE} WHERE NOT (id = ANY($1::text[]))`, [ids]);
    else await executor.query(`DELETE FROM ${OFFER_TABLE}`);
  } else {
    const currentIds = new Set(ids);
    const removedIds = [...previous.keys()].filter((id) => !currentIds.has(id));
    if (removedIds.length) await executor.query(`DELETE FROM ${OFFER_TABLE} WHERE id = ANY($1::text[])`, [removedIds]);
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

function isRenderInternalDatabase(connectionString) {
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    return /^dpg-[a-z0-9-]+-a$/.test(hostname) || hostname.endsWith('.internal');
  } catch {
    return false;
  }
}

function databaseSsl(connectionString) {
  const mode = String(process.env.PGSSL || '').trim().toLowerCase();
  if (mode === 'disable' || isLocalDatabase(connectionString) || isRenderInternalDatabase(connectionString)) return false;
  const certificate = String(process.env.PGSSL_ROOT_CERT || '').replace(/\\n/g, '\n').trim();
  return { rejectUnauthorized: true, ...(certificate ? { ca: certificate } : {}) };
}

export function createPostgresStateBackend({
  connectionString,
  loadInitialData,
  normalizeData,
  restoreData,
  protectData,
  retireDataKey = async () => {},
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
        ssl: databaseSsl(connectionString)
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
        const state = await pool.query('SELECT version, schema_version FROM promoshop_state WHERE id = 1');
        if (!state.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');
        const currentSchemaVersion = Number(state.rows[0].schema_version || 1);
        const current = currentSchemaVersion < POSTGRES_SCHEMA_VERSION
          ? await pool.query('SELECT * FROM promoshop_state WHERE id = 1')
          : state;
        if (!current.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');
        const row = current.rows[0];
        const wasRelational = currentSchemaVersion >= POSTGRES_SCHEMA_VERSION;
        try {
          await ensureOfferTable(pool);
          await ensureRelationalTables(pool);
          if (currentSchemaVersion < POSTGRES_SCHEMA_VERSION) {
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
            if (restored.requiresReencrypt) await retireDataKey();
          }
          relationalReady = true;
          if (!suppliedPool) {
            await ensureRowSecurity(pool).catch((securityError) => {
              console.warn(`PostgreSQL: não foi possível ativar toda a proteção por linhas: ${securityError.message}`);
            });
          }
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
    let loadedVersion = Number(row.version);
    if (relationalReady && restored.requiresReencrypt) {
      const protectedData = await protectData(loadedData);
      await syncSections(pool, protectedData, ['inbox', 'privacyConsents', 'analytics']);
      const migrated = await pool.query('UPDATE promoshop_state SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
      loadedVersion = Number(migrated.rows[0]?.version || loadedVersion + 1);
      await retireDataKey();
    }
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
    const keys = [...new Set(requestedKeys)]
      .filter((key) => STATE_KEYS.includes(key) || Object.hasOwn(ENTITY_TABLES, key))
      .sort();
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

        const changedKeys = [...STATE_KEYS, ...Object.keys(ENTITY_TABLES)]
          .filter((key) => serialize(before[key]) !== serialize(data[key]));
        if (!useRelationalStore && changedKeys.some((key) => ['campaigns', 'priceMonitors'].includes(key))) {
          throw new Error('O armazenamento relacional do PostgreSQL ainda não está disponível para salvar campanhas e monitoramentos. Tente novamente em instantes.');
        }
        const persistedKeys = restored.requiresReencrypt
          ? [...new Set([...changedKeys, 'inbox', 'privacyConsents', 'analytics'])]
          : changedKeys;
        if (persistedKeys.length) {
          const protectedAfter = await protectData(data);
          if (useRelationalStore) {
            if (changedKeys.includes('offers')) await syncOfferTable(client, data.offers, before.offers);
            for (const [key, table] of Object.entries(ENTITY_TABLES)) {
              if (changedKeys.includes(key)) await syncJsonEntityTable(client, table, data[key], before[key]);
            }
            await syncSections(client, protectedAfter, persistedKeys);
          }
          let updated;
          if (useRelationalStore) {
            updated = await client.query(
              'UPDATE promoshop_state SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version'
            );
          } else {
            const statePersistedKeys = STATE_KEYS.filter((key) => persistedKeys.includes(key));
            const assignments = statePersistedKeys.map((key, index) => `${STATE_COLUMNS[key]} = $${index + 1}::jsonb`);
            const values = statePersistedKeys.map((key) => serialize(protectedAfter[key]));
            updated = await client.query(
              `UPDATE promoshop_state SET ${assignments.length ? `${assignments.join(', ')}, ` : ''}version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version`,
              values
            );
          }
          cachedVersion = Number(updated.rows[0].version);
        } else {
          cachedVersion = Number(row.version);
        }

        await client.query('COMMIT');
        if (restored.requiresReencrypt) await retireDataKey();
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
