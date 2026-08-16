import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const keyFile = path.join(dataDir, '.secret-key');
const secretsFile = path.join(dataDir, 'secrets.enc');
let secretsUpdateQueue = Promise.resolve();

export function normalizeApiKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored?.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const calculated = crypto.scryptSync(password, salt, 64).toString('hex');
  return expected.length === calculated.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(calculated));
}

async function getKey() {
  await fs.mkdir(dataDir, { recursive: true });
  try { return Buffer.from(await fs.readFile(keyFile, 'utf8'), 'hex'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    await fs.writeFile(keyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    return key;
  }
}

async function encrypt(value) {
  const key = await getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}

async function decrypt(payload) {
  const key = await getKey();
  const parsed = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8'));
}

async function writeSecrets(value) {
  const temporaryFile = `${secretsFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporaryFile, await encrypt(value), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryFile, secretsFile);
}

async function defaults() {
  return {
    adminUser: 'admin',
    adminPasswordHash: hashPassword('admin123'),
    mercadoLivreClientId: '',
    mercadoLivreClientSecret: '',
    mercadoLivreAccessToken: '',
    mercadoLivreRefreshToken: '',
    mercadoLivreTokenExpiresAt: 0,
    mercadoLivreUserId: '',
    mercadoLivreOAuthState: '',
    mercadoLivreCodeVerifier: '',
    mercadoLivreOAuthRedirectUri: '',
    shopeeFeedUrl: '',
    shopeeAppId: '',
    shopeeAppSecret: '',
    aliexpressAppKey: '',
    aliexpressAppSecret: '',
    aliexpressAppSignature: '',
    aiApiKey: '',
    geminiApiKey: '',
    workerToken: crypto.randomBytes(32).toString('hex')
  };
}

export async function readSecrets() {
  await fs.mkdir(dataDir, { recursive: true });
  try { return await decrypt(await fs.readFile(secretsFile, 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const value = await defaults();
    await writeSecrets(value);
    return value;
  }
}

async function updateSecretsUnlocked(changes) {
  const current = await readSecrets();
  const next = { ...current };
  if (changes.adminUser) next.adminUser = String(changes.adminUser).trim();
  if (changes.adminPassword) next.adminPasswordHash = hashPassword(String(changes.adminPassword));
  if (typeof changes.mercadoLivreClientId === 'string' && changes.mercadoLivreClientId.trim()) next.mercadoLivreClientId = changes.mercadoLivreClientId.trim();
  if (typeof changes.mercadoLivreClientSecret === 'string' && changes.mercadoLivreClientSecret.trim()) next.mercadoLivreClientSecret = changes.mercadoLivreClientSecret.trim();
  if (typeof changes.mercadoLivreAccessToken === 'string' && changes.mercadoLivreAccessToken.trim()) next.mercadoLivreAccessToken = changes.mercadoLivreAccessToken.trim();
  if (typeof changes.mercadoLivreRefreshToken === 'string') next.mercadoLivreRefreshToken = changes.mercadoLivreRefreshToken.trim();
  if (Number.isFinite(Number(changes.mercadoLivreTokenExpiresAt))) next.mercadoLivreTokenExpiresAt = Number(changes.mercadoLivreTokenExpiresAt);
  if (changes.mercadoLivreUserId !== undefined) next.mercadoLivreUserId = String(changes.mercadoLivreUserId || '').trim();
  if (typeof changes.mercadoLivreOAuthState === 'string') next.mercadoLivreOAuthState = changes.mercadoLivreOAuthState.trim();
  if (typeof changes.mercadoLivreCodeVerifier === 'string') next.mercadoLivreCodeVerifier = changes.mercadoLivreCodeVerifier.trim();
  if (typeof changes.mercadoLivreOAuthRedirectUri === 'string') next.mercadoLivreOAuthRedirectUri = changes.mercadoLivreOAuthRedirectUri.trim();
  if (changes.clearMercadoLivreAccessToken) next.mercadoLivreAccessToken = '';
  if (changes.clearMercadoLivreConnection) {
    next.mercadoLivreAccessToken = '';
    next.mercadoLivreRefreshToken = '';
    next.mercadoLivreTokenExpiresAt = 0;
    next.mercadoLivreUserId = '';
    next.mercadoLivreOAuthState = '';
    next.mercadoLivreCodeVerifier = '';
    next.mercadoLivreOAuthRedirectUri = '';
  }
  if (typeof changes.shopeeFeedUrl === 'string') next.shopeeFeedUrl = changes.shopeeFeedUrl.trim();
  if (typeof changes.shopeeAppId === 'string' && changes.shopeeAppId.trim()) next.shopeeAppId = changes.shopeeAppId.trim();
  if (typeof changes.shopeeAppSecret === 'string' && changes.shopeeAppSecret.trim()) next.shopeeAppSecret = changes.shopeeAppSecret.trim();
  if (changes.clearShopeeCredentials) { next.shopeeAppId = ''; next.shopeeAppSecret = ''; }
  if (typeof changes.aliexpressAppKey === 'string' && changes.aliexpressAppKey.trim()) next.aliexpressAppKey = changes.aliexpressAppKey.trim();
  if (typeof changes.aliexpressAppSecret === 'string' && changes.aliexpressAppSecret.trim()) next.aliexpressAppSecret = changes.aliexpressAppSecret.trim();
  if (typeof changes.aliexpressAppSignature === 'string' && changes.aliexpressAppSignature.trim()) next.aliexpressAppSignature = changes.aliexpressAppSignature.trim();
  if (changes.clearAliexpressCredentials) { next.aliexpressAppKey = ''; next.aliexpressAppSecret = ''; next.aliexpressAppSignature = ''; }
  if (typeof changes.aiApiKey === 'string' && normalizeApiKey(changes.aiApiKey)) next.aiApiKey = normalizeApiKey(changes.aiApiKey);
  if (changes.clearAiApiKey) next.aiApiKey = '';
  if (typeof changes.geminiApiKey === 'string' && normalizeApiKey(changes.geminiApiKey)) next.geminiApiKey = normalizeApiKey(changes.geminiApiKey);
  if (changes.clearGeminiApiKey) next.geminiApiKey = '';
  await writeSecrets(next);
  return next;
}

export function updateSecrets(changes) {
  const operation = secretsUpdateQueue.then(
    () => updateSecretsUnlocked(changes),
    () => updateSecretsUnlocked(changes)
  );
  secretsUpdateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function secretStatus(secrets) {
  const aiApiKey = normalizeApiKey(secrets.aiApiKey);
  const geminiApiKey = normalizeApiKey(secrets.geminiApiKey);
  return {
    adminUser: secrets.adminUser,
    mercadoLivreClientIdConfigured: Boolean(secrets.mercadoLivreClientId),
    mercadoLivreClientSecretConfigured: Boolean(secrets.mercadoLivreClientSecret),
    mercadoLivreClientId: secrets.mercadoLivreClientId || '',
    mercadoLivreAccessTokenConfigured: Boolean(secrets.mercadoLivreAccessToken),
    mercadoLivreRefreshTokenConfigured: Boolean(secrets.mercadoLivreRefreshToken),
    mercadoLivreConnected: Boolean(secrets.mercadoLivreAccessToken && (secrets.mercadoLivreRefreshToken || !secrets.mercadoLivreTokenExpiresAt)),
    mercadoLivreTokenExpiresAt: Number(secrets.mercadoLivreTokenExpiresAt || 0),
    mercadoLivreUserId: secrets.mercadoLivreUserId || '',
    shopeeFeedUrlConfigured: Boolean(secrets.shopeeFeedUrl),
    shopeeFeedUrl: secrets.shopeeFeedUrl || '',
    shopeeAppIdConfigured: Boolean(secrets.shopeeAppId),
    shopeeAppSecretConfigured: Boolean(secrets.shopeeAppSecret),
    shopeeAppId: secrets.shopeeAppId || '',
    aliexpressAppKeyConfigured: Boolean(secrets.aliexpressAppKey),
    aliexpressAppSecretConfigured: Boolean(secrets.aliexpressAppSecret),
    aliexpressAppSignatureConfigured: Boolean(secrets.aliexpressAppSignature),
    aliexpressAppKey: secrets.aliexpressAppKey || '',
    aiApiKeyConfigured: Boolean(aiApiKey),
    aiApiKeyFormatValid: !aiApiKey || (aiApiKey.startsWith('gsk_') && aiApiKey.length >= 20),
    aiApiKeyEnding: aiApiKey ? aiApiKey.slice(-4) : '',
    geminiApiKeyConfigured: Boolean(geminiApiKey),
    geminiApiKeyFormatValid: !geminiApiKey || (geminiApiKey.startsWith('AIza') && geminiApiKey.length >= 20),
    geminiApiKeyEnding: geminiApiKey ? geminiApiKey.slice(-4) : ''
  };
}
