import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const keyFile = path.join(dataDir, '.secret-key');
const secretsFile = path.join(dataDir, 'secrets.enc');

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
  catch {
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

async function defaults() {
  return {
    adminUser: 'admin',
    adminPasswordHash: hashPassword('admin123'),
    mercadoLivreAccessToken: '',
    shopeeFeedUrl: '',
    shopeeAppId: '',
    shopeeAppSecret: '',
    aliexpressAppKey: '',
    aliexpressAppSecret: '',
    aliexpressAppSignature: '',
    aiApiKey: '',
    workerToken: crypto.randomBytes(32).toString('hex')
  };
}

export async function readSecrets() {
  await fs.mkdir(dataDir, { recursive: true });
  try { return await decrypt(await fs.readFile(secretsFile, 'utf8')); }
  catch {
    const value = await defaults();
    await fs.writeFile(secretsFile, await encrypt(value), { encoding: 'utf8', mode: 0o600 });
    return value;
  }
}

export async function updateSecrets(changes) {
  const current = await readSecrets();
  const next = { ...current };
  if (changes.adminUser) next.adminUser = String(changes.adminUser).trim();
  if (changes.adminPassword) next.adminPasswordHash = hashPassword(String(changes.adminPassword));
  if (typeof changes.mercadoLivreAccessToken === 'string' && changes.mercadoLivreAccessToken.trim()) next.mercadoLivreAccessToken = changes.mercadoLivreAccessToken.trim();
  if (changes.clearMercadoLivreAccessToken) next.mercadoLivreAccessToken = '';
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
  await fs.writeFile(secretsFile, await encrypt(next), { encoding: 'utf8', mode: 0o600 });
  return next;
}

export function secretStatus(secrets) {
  const aiApiKey = normalizeApiKey(secrets.aiApiKey);
  return {
    adminUser: secrets.adminUser,
    mercadoLivreAccessTokenConfigured: Boolean(secrets.mercadoLivreAccessToken),
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
    aiApiKeyEnding: aiApiKey ? aiApiKey.slice(-4) : ''
  };
}
