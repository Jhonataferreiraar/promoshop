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

function serialize(value) {
  return JSON.stringify(value ?? null);
}

function rowToPersistedData(row) {
  return Object.fromEntries(
    STATE_KEYS.map((key) => [key, row[STATE_COLUMNS[key]]])
  );
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
  let connected = false;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = import('pg').then(({ Pool }) => new Pool({
        connectionString,
        max: Math.max(2, Math.min(10, Number(process.env.PG_POOL_MAX) || 5)),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
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

        const existing = await pool.query('SELECT version FROM promoshop_state WHERE id = 1');
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
    return Number(result.rows[0].version);
  }

  async function loadCurrentData() {
    const pool = await getPool();
    const result = await pool.query('SELECT * FROM promoshop_state WHERE id = 1');
    if (!result.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');
    const row = result.rows[0];
    const restored = await restoreData(rowToPersistedData(row));
    cachedData = normalizeData(restored.data);
    cachedVersion = Number(row.version);
    lastVersionCheckAt = Date.now();
    connected = true;
    return cachedData;
  }

  async function read() {
    await ensureDatabase();
    if (cachedData && Date.now() - lastVersionCheckAt < CACHE_REVALIDATE_MS) return cachedData;
    const version = await loadVersion();
    lastVersionCheckAt = Date.now();
    if (cachedData && version === cachedVersion) return cachedData;
    return loadCurrentData();
  }

  async function update(mutator) {
    writeChain = writeChain.catch(() => {}).then(async () => {
      await ensureDatabase();
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT * FROM promoshop_state WHERE id = 1 FOR UPDATE');
        if (!result.rowCount) throw new Error('O estado principal do PromoShop não foi encontrado no PostgreSQL.');

        const row = result.rows[0];
        const persistedBefore = rowToPersistedData(row);
        const restored = await restoreData(structuredClone(persistedBefore));
        const before = normalizeData(restored.data);
        const data = structuredClone(before);
        const mutatorResult = await mutator(data);
        compactData(data);

        const changedKeys = STATE_KEYS.filter((key) => serialize(before[key]) !== serialize(data[key]));
        if (changedKeys.length) {
          const protectedAfter = await protectData(data);
          const assignments = changedKeys.map((key, index) => `${STATE_COLUMNS[key]} = $${index + 1}::jsonb`);
          const values = changedKeys.map((key) => serialize(protectedAfter[key]));
          const updated = await client.query(
            `UPDATE promoshop_state SET ${assignments.join(', ')}, version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version`,
            values
          );
          cachedVersion = Number(updated.rows[0].version);
        } else {
          cachedVersion = Number(row.version);
        }

        await client.query('COMMIT');
        cachedData = data;
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
      cachedVersion: cachedVersion >= 0 ? cachedVersion : null
    };
  }

  return { read, update, status };
}
