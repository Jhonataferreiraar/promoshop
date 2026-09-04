import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { normalizeAdminPermissions } from './adminPermissions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const keyFile = path.join(dataDir, '.secret-key');
const vaultPath = path.join(dataDir, 'secrets.enc');
let secretsUpdateQueue = Promise.resolve();
let cachedSecrets = null;
let cachedSecretsAt = 0;
let secretsReadPromise = null;
const SECRETS_CACHE_TTL_MS = 5_000;
const FILE_TEXT_ENCODING = 'utf8';

export function normalizeApiKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '');
}

const PASSWORD_SCRYPT_N = 2 ** 17;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;
const PASSWORD_SCRYPT_MAXMEM = 192 * 1024 * 1024;

function derivePassword(password, salt, options = {}) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await derivePassword(password, salt, {
    N: PASSWORD_SCRYPT_N,
    r: PASSWORD_SCRYPT_R,
    p: PASSWORD_SCRYPT_P,
    maxmem: PASSWORD_SCRYPT_MAXMEM
  })).toString('hex');
  return `scrypt$v2$${PASSWORD_SCRYPT_N}$${PASSWORD_SCRYPT_R}$${PASSWORD_SCRYPT_P}$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  const value = String(stored || '');
  const versioned = /^scrypt\$v2\$(\d+)\$(\d+)\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(value);
  if (versioned) {
    const [, rawN, rawR, rawP, salt, expected] = versioned;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (N < 2 ** 14 || N > PASSWORD_SCRYPT_N || r < 1 || r > 16 || p < 1 || p > 4) return false;
    const calculated = (await derivePassword(password, salt, { N, r, p, maxmem: PASSWORD_SCRYPT_MAXMEM })).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(calculated, 'hex'));
  }
  if (!value.includes(':')) return false;
  const [salt, expected] = value.split(':');
  if (!/^[a-f0-9]{16,64}$/i.test(salt) || !/^[a-f0-9]{128}$/i.test(expected)) return false;
  const calculated = (await derivePassword(password, salt)).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(calculated, 'hex'));
}

export function passwordNeedsRehash(stored) {
  return !String(stored || '').startsWith(`scrypt$v2$${PASSWORD_SCRYPT_N}$${PASSWORD_SCRYPT_R}$${PASSWORD_SCRYPT_P}$`);
}

const ADMIN_ROLES = new Set(['editor', 'viewer']);

function normalizeAdminUsername(value) {
  return String(value || '').trim().slice(0, 100);
}

function normalizeAdminUsers(value, ownerUsername = '') {
  const owner = normalizeAdminUsername(ownerUsername).toLocaleLowerCase('pt-BR');
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, 20).map((user) => {
    const username = normalizeAdminUsername(user?.username);
    const key = username.toLocaleLowerCase('pt-BR');
    if (!/^[^\s]{3,100}$/.test(username) || key === owner || seen.has(key)) return null;
    if (!String(user?.passwordHash || '').startsWith('scrypt$')) return null;
    seen.add(key);
    return {
      id: /^[a-zA-Z0-9_-]{8,120}$/.test(String(user?.id || ''))
        ? String(user.id)
        : `admin_${crypto.createHash('sha256').update(`user\0${key}`).digest('hex').slice(0, 16)}`,
      username,
      passwordHash: String(user.passwordHash).slice(0, 500),
      role: ADMIN_ROLES.has(String(user?.role)) ? String(user.role) : 'viewer',
      permissions: normalizeAdminPermissions(user?.permissions, ADMIN_ROLES.has(String(user?.role)) ? String(user.role) : 'viewer'),
      active: user?.active !== false,
      createdAt: String(user?.createdAt || new Date().toISOString()).slice(0, 40),
      updatedAt: String(user?.updatedAt || user?.createdAt || new Date().toISOString()).slice(0, 40)
    };
  }).filter(Boolean);
}

function environmentEncryptionKey() {
  const configured = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim();
  if (!configured) return null;
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  try {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === configured.replace(/=+$/, '')) return decoded;
  } catch {}
  if (configured.length >= 32) return crypto.createHash('sha256').update(configured, 'utf8').digest();
  throw new Error('SECRETS_ENCRYPTION_KEY precisa ter pelo menos 32 caracteres.');
}

async function fileEncryptionKey({ create = true } = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'hex');
    if (key.length !== 32) throw new Error('A chave local de segredos está corrompida.');
    return key;
  }
  catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
    const key = crypto.randomBytes(32);
    await fs.writeFile(keyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    return key;
  }
}

async function activeEncryptionKey() {
  return environmentEncryptionKey() || fileEncryptionKey();
}

async function encrypt(value, providedKey = null) {
  const key = providedKey || await activeEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}

function decryptWithKey(payload, key) {
  const parsed = JSON.parse(payload);
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Segredo criptografado inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8'));
}

async function decrypt(payload) {
  const environmentKey = environmentEncryptionKey();
  if (environmentKey) {
    try {
      return { value: decryptWithKey(payload, environmentKey), source: 'environment' };
    } catch (environmentError) {
      try {
        const fileKey = await fileEncryptionKey({ create: false });
        return { value: decryptWithKey(payload, fileKey), source: 'file' };
      } catch {
        throw new Error(`Não foi possível descriptografar os segredos com a chave configurada: ${environmentError.message}`);
      }
    }
  }
  return { value: decryptWithKey(payload, await fileEncryptionKey()), source: 'file' };
}

async function writeSecrets(value) {
  const temporaryFile = `${vaultPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporaryFile, await encrypt(value), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporaryFile, vaultPath);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => { });
    throw error;
  }
  cachedSecrets = value;
  cachedSecretsAt = Date.now();
  if (environmentEncryptionKey()) await fs.unlink(keyFile).catch((error) => {
    if (error?.code !== 'ENOENT') console.warn('A chave local antiga dos segredos não pôde ser removida.');
  });
}

async function defaults() {
  const bootstrapPassword = String(process.env.ADMIN_PASSWORD || '');
  return {
    adminUser: 'admin',
    adminPasswordHash: bootstrapPassword.length >= 12 ? await hashPassword(bootstrapPassword) : '',
    adminSessionVersion: 0,
    adminUsers: [],
    mercadoLivreClientId: '',
    mercadoLivreClientSecret: '',
    mercadoLivreAccessToken: '',
    mercadoLivreRefreshToken: '',
    mercadoLivreTokenExpiresAt: 0,
    mercadoLivreUserId: '',
    mercadoLivreOAuthState: '',
    mercadoLivreOAuthStateExpiresAt: 0,
    mercadoLivreCodeVerifier: '',
    mercadoLivreOAuthRedirectUri: '',
    mercadoLivreAffiliateCookie: '',
    mercadoLivreAffiliateCsrfToken: '',
    mercadoLivreAffiliateTag: '',
    shopeeFeedUrl: '',
    shopeeAppId: '',
    shopeeAppSecret: '',
    aliexpressAppKey: '',
    aliexpressAppSecret: '',
    aliexpressAppSignature: '',
    magaluAffiliateId: '',
    magaluApiKey: '',
    netshoesAffiliateId: '',
    netshoesApiKey: '',
    googleSearchConsoleClientId: '',
    googleSearchConsoleClientSecret: '',
    googleSearchConsoleAccessToken: '',
    googleSearchConsoleRefreshToken: '',
    googleSearchConsoleTokenExpiresAt: 0,
    googleSearchConsoleOAuthState: '',
    googleSearchConsoleOAuthStateExpiresAt: 0,
    instagramAppId: '',
    instagramAppSecret: '',
    instagramAccessToken: '',
    instagramUserId: '',
    instagramUsername: '',
    instagramProfilePictureUrl: '',
    instagramTokenExpiresAt: 0,
    instagramOAuthState: '',
    instagramOAuthStateExpiresAt: 0,
    brevoInboundToken: crypto.randomBytes(32).toString('hex'),
    extensionIngestToken: '',
    extensionCouponIngestToken: '',
    extensionOfferIngestToken: '',
    aiApiKey: '',
    geminiApiKey: '',
    openaiApiKey: '',
    workerToken: crypto.randomBytes(32).toString('hex')
  };
}

export async function readSecrets() {
  if (cachedSecrets && Date.now() - cachedSecretsAt < SECRETS_CACHE_TTL_MS) {
    return structuredClone(cachedSecrets);
  }
  if (secretsReadPromise) return secretsReadPromise;
  secretsReadPromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      const decrypted = await decrypt(await fs.readFile(vaultPath, FILE_TEXT_ENCODING));
      const value = decrypted.value;
      value.adminUsers = normalizeAdminUsers(value.adminUsers, process.env.ADMIN_USER || value.adminUser);
      if (decrypted.source === 'file' && environmentEncryptionKey()) {
        await writeSecrets(value);
      }
      if (!value.brevoInboundToken) {
        value.brevoInboundToken = crypto.randomBytes(32).toString('hex');
        await writeSecrets(value);
      } else {
        cachedSecrets = value;
        cachedSecretsAt = Date.now();
      }
      return structuredClone(value);
    }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const value = await defaults();
      await writeSecrets(value);
      return structuredClone(value);
    }
  })();
  try {
    return await secretsReadPromise;
  } finally {
    secretsReadPromise = null;
  }
}

async function updateSecretsUnlocked(changes) {
  const current = await readSecrets();
  const next = { ...current };
  if (changes.adminUser !== undefined) {
    const username = normalizeAdminUsername(changes.adminUser);
    if (!/^[^\s]{3,100}$/.test(username)) throw new Error('O usuário proprietário precisa ter entre 3 e 100 caracteres, sem espaços.');
    if (username !== String(next.adminUser || '').trim()) next.adminSessionVersion = Number(next.adminSessionVersion || 0) + 1;
    next.adminUser = username;
  }
  if (changes.adminPassword) {
    next.adminPasswordHash = await hashPassword(String(changes.adminPassword).slice(0, 256));
    next.adminSessionVersion = Number(next.adminSessionVersion || 0) + 1;
  }
  if (changes.rehashAdminPassword) {
    next.adminPasswordHash = await hashPassword(String(changes.rehashAdminPassword).slice(0, 256));
  }
  next.adminUsers = normalizeAdminUsers(next.adminUsers, process.env.ADMIN_USER || next.adminUser);
  if (changes.adminUserAdd && typeof changes.adminUserAdd === 'object' && !Array.isArray(changes.adminUserAdd)) {
    const requested = changes.adminUserAdd;
    const username = normalizeAdminUsername(requested.username);
    const role = String(requested.role || 'viewer');
    const password = String(requested.password || '');
    if (!/^[^\s]{3,100}$/.test(username)) throw new Error('O usuário adicional precisa ter entre 3 e 100 caracteres, sem espaços.');
    if (!ADMIN_ROLES.has(role)) throw new Error('O papel do usuário adicional é inválido.');
    if (password.length < 12) throw new Error('A senha do usuário adicional precisa ter pelo menos 12 caracteres.');
    const ownerUsername = process.env.ADMIN_USER || next.adminUser;
    const duplicate = [ownerUsername, ...next.adminUsers.map((user) => user.username)].some((entry) => String(entry).toLocaleLowerCase('pt-BR') === username.toLocaleLowerCase('pt-BR'));
    if (duplicate) throw new Error('Já existe um usuário com esse nome.');
    if (next.adminUsers.length >= 20) throw new Error('O limite seguro de usuários adicionais foi atingido.');
    const normalizedRole = role;
    next.adminUsers.push({
      id: `admin_${crypto.randomBytes(8).toString('hex')}`,
      username,
      passwordHash: await hashPassword(password.slice(0, 256)),
      role: normalizedRole,
      permissions: normalizeAdminPermissions(requested.permissions, normalizedRole),
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  if (changes.adminUserRemove) {
    const target = String(changes.adminUserRemove || '').trim().toLocaleLowerCase('pt-BR');
    next.adminUsers = next.adminUsers.filter((user) => user.id.toLocaleLowerCase('pt-BR') !== target && user.username.toLocaleLowerCase('pt-BR') !== target);
  }
  if (changes.adminUserUpdate && typeof changes.adminUserUpdate === 'object' && !Array.isArray(changes.adminUserUpdate)) {
    const requested = changes.adminUserUpdate;
    const target = String(requested.id || requested.username || '').trim().toLocaleLowerCase('pt-BR');
    const user = next.adminUsers.find((entry) => entry.id.toLocaleLowerCase('pt-BR') === target || entry.username.toLocaleLowerCase('pt-BR') === target);
    if (!user) throw new Error('Usuário adicional não encontrado.');
    if (requested.role !== undefined) {
      if (!ADMIN_ROLES.has(String(requested.role))) throw new Error('O papel do usuário adicional é inválido.');
      user.role = String(requested.role);
      // Alterar o papel sem enviar uma matriz mantém o comportamento esperado
      // das contas antigas: editor recebe edição ampla e consulta recebe apenas
      // leitura. A matriz explícita abaixo sempre tem precedência.
      if (requested.permissions === undefined) user.permissions = normalizeAdminPermissions(undefined, user.role);
    }
    if (requested.permissions !== undefined) {
      if (!requested.permissions || typeof requested.permissions !== 'object' || Array.isArray(requested.permissions)) {
        throw new Error('As permissões do usuário adicional são inválidas.');
      }
      user.permissions = normalizeAdminPermissions(requested.permissions, user.role);
    }
    if (requested.active !== undefined) user.active = requested.active === true;
    if (String(requested.password || '').length > 0) {
      if (String(requested.password).length < 12) throw new Error('A senha do usuário adicional precisa ter pelo menos 12 caracteres.');
      user.passwordHash = await hashPassword(String(requested.password).slice(0, 256));
    }
    user.updatedAt = new Date().toISOString();
  }
  if (typeof changes.mercadoLivreClientId === 'string' && changes.mercadoLivreClientId.trim()) next.mercadoLivreClientId = changes.mercadoLivreClientId.trim();
  if (typeof changes.mercadoLivreClientSecret === 'string' && changes.mercadoLivreClientSecret.trim()) next.mercadoLivreClientSecret = changes.mercadoLivreClientSecret.trim();
  if (typeof changes.mercadoLivreAccessToken === 'string' && changes.mercadoLivreAccessToken.trim()) next.mercadoLivreAccessToken = changes.mercadoLivreAccessToken.trim();
  if (typeof changes.mercadoLivreRefreshToken === 'string') next.mercadoLivreRefreshToken = changes.mercadoLivreRefreshToken.trim();
  if (Number.isFinite(Number(changes.mercadoLivreTokenExpiresAt))) next.mercadoLivreTokenExpiresAt = Number(changes.mercadoLivreTokenExpiresAt);
  if (changes.mercadoLivreUserId !== undefined) next.mercadoLivreUserId = String(changes.mercadoLivreUserId || '').trim();
  if (typeof changes.mercadoLivreOAuthState === 'string') next.mercadoLivreOAuthState = changes.mercadoLivreOAuthState.trim();
  if (Number.isFinite(Number(changes.mercadoLivreOAuthStateExpiresAt))) next.mercadoLivreOAuthStateExpiresAt = Number(changes.mercadoLivreOAuthStateExpiresAt);
  if (typeof changes.mercadoLivreCodeVerifier === 'string') next.mercadoLivreCodeVerifier = changes.mercadoLivreCodeVerifier.trim();
  if (typeof changes.mercadoLivreOAuthRedirectUri === 'string') next.mercadoLivreOAuthRedirectUri = changes.mercadoLivreOAuthRedirectUri.trim();
  if (changes.clearMercadoLivreAccessToken) next.mercadoLivreAccessToken = '';
  if (changes.clearMercadoLivreConnection) {
    next.mercadoLivreAccessToken = '';
    next.mercadoLivreRefreshToken = '';
    next.mercadoLivreTokenExpiresAt = 0;
    next.mercadoLivreUserId = '';
    next.mercadoLivreOAuthState = '';
    next.mercadoLivreOAuthStateExpiresAt = 0;
    next.mercadoLivreCodeVerifier = '';
    next.mercadoLivreOAuthRedirectUri = '';
  }
  if (
    typeof changes.mercadoLivreAffiliateCookie === 'string' &&
    changes.mercadoLivreAffiliateCookie.trim()
  ) {
    next.mercadoLivreAffiliateCookie =
      changes.mercadoLivreAffiliateCookie.trim();
  }

  if (
    typeof changes.mercadoLivreAffiliateCsrfToken === 'string' &&
    changes.mercadoLivreAffiliateCsrfToken.trim()
  ) {
    next.mercadoLivreAffiliateCsrfToken =
      changes.mercadoLivreAffiliateCsrfToken.trim();
  }

  if (
    typeof changes.mercadoLivreAffiliateTag === 'string' &&
    changes.mercadoLivreAffiliateTag.trim()
  ) {
    next.mercadoLivreAffiliateTag =
      changes.mercadoLivreAffiliateTag.trim();
  }

  if (changes.clearMercadoLivreAffiliateSession) {
    next.mercadoLivreAffiliateCookie = '';
    next.mercadoLivreAffiliateCsrfToken = '';
  }
  if (typeof changes.shopeeFeedUrl === 'string') next.shopeeFeedUrl = changes.shopeeFeedUrl.trim();
  if (typeof changes.shopeeAppId === 'string' && changes.shopeeAppId.trim()) next.shopeeAppId = changes.shopeeAppId.trim();
  if (typeof changes.shopeeAppSecret === 'string' && changes.shopeeAppSecret.trim()) next.shopeeAppSecret = changes.shopeeAppSecret.trim();
  if (changes.clearShopeeCredentials) { next.shopeeAppId = ''; next.shopeeAppSecret = ''; }
  if (typeof changes.aliexpressAppKey === 'string' && changes.aliexpressAppKey.trim()) next.aliexpressAppKey = changes.aliexpressAppKey.trim();
  if (typeof changes.aliexpressAppSecret === 'string' && changes.aliexpressAppSecret.trim()) next.aliexpressAppSecret = changes.aliexpressAppSecret.trim();
  if (typeof changes.aliexpressAppSignature === 'string' && changes.aliexpressAppSignature.trim()) next.aliexpressAppSignature = changes.aliexpressAppSignature.trim();
  if (changes.clearAliexpressCredentials) { next.aliexpressAppKey = ''; next.aliexpressAppSecret = ''; next.aliexpressAppSignature = ''; }
  if (typeof changes.magaluAffiliateId === 'string' && changes.magaluAffiliateId.trim()) next.magaluAffiliateId = changes.magaluAffiliateId.trim();
  if (typeof changes.magaluApiKey === 'string' && changes.magaluApiKey.trim()) next.magaluApiKey = changes.magaluApiKey.trim();
  if (typeof changes.netshoesAffiliateId === 'string' && changes.netshoesAffiliateId.trim()) next.netshoesAffiliateId = changes.netshoesAffiliateId.trim();
  if (typeof changes.netshoesApiKey === 'string' && changes.netshoesApiKey.trim()) next.netshoesApiKey = changes.netshoesApiKey.trim();
  if (changes.clearMagaluCredentials) { next.magaluAffiliateId = ''; next.magaluApiKey = ''; }
  if (changes.clearNetshoesCredentials) { next.netshoesAffiliateId = ''; next.netshoesApiKey = ''; }
  if (typeof changes.googleSearchConsoleClientId === 'string' && changes.googleSearchConsoleClientId.trim()) next.googleSearchConsoleClientId = changes.googleSearchConsoleClientId.trim();
  if (typeof changes.googleSearchConsoleClientSecret === 'string' && changes.googleSearchConsoleClientSecret.trim()) next.googleSearchConsoleClientSecret = changes.googleSearchConsoleClientSecret.trim();
  if (typeof changes.googleSearchConsoleAccessToken === 'string') next.googleSearchConsoleAccessToken = changes.googleSearchConsoleAccessToken.trim();
  if (typeof changes.googleSearchConsoleRefreshToken === 'string' && changes.googleSearchConsoleRefreshToken.trim()) next.googleSearchConsoleRefreshToken = changes.googleSearchConsoleRefreshToken.trim();
  if (Number.isFinite(Number(changes.googleSearchConsoleTokenExpiresAt))) next.googleSearchConsoleTokenExpiresAt = Number(changes.googleSearchConsoleTokenExpiresAt);
  if (typeof changes.googleSearchConsoleOAuthState === 'string') next.googleSearchConsoleOAuthState = changes.googleSearchConsoleOAuthState.trim();
  if (Number.isFinite(Number(changes.googleSearchConsoleOAuthStateExpiresAt))) next.googleSearchConsoleOAuthStateExpiresAt = Number(changes.googleSearchConsoleOAuthStateExpiresAt);
  if (changes.clearGoogleSearchConsoleConnection) { next.googleSearchConsoleAccessToken = ''; next.googleSearchConsoleRefreshToken = ''; next.googleSearchConsoleTokenExpiresAt = 0; next.googleSearchConsoleOAuthState = ''; next.googleSearchConsoleOAuthStateExpiresAt = 0; }
  if (typeof changes.instagramAppId === 'string' && changes.instagramAppId.trim()) next.instagramAppId = changes.instagramAppId.trim();
  if (typeof changes.instagramAppSecret === 'string' && changes.instagramAppSecret.trim()) next.instagramAppSecret = changes.instagramAppSecret.trim();
  if (typeof changes.instagramAccessToken === 'string') next.instagramAccessToken = changes.instagramAccessToken.trim();
  if (changes.instagramUserId !== undefined) next.instagramUserId = String(changes.instagramUserId || '').trim();
  if (changes.instagramUsername !== undefined) next.instagramUsername = String(changes.instagramUsername || '').trim();
  if (changes.instagramProfilePictureUrl !== undefined) next.instagramProfilePictureUrl = String(changes.instagramProfilePictureUrl || '').trim();
  if (Number.isFinite(Number(changes.instagramTokenExpiresAt))) next.instagramTokenExpiresAt = Number(changes.instagramTokenExpiresAt);
  if (typeof changes.instagramOAuthState === 'string') next.instagramOAuthState = changes.instagramOAuthState.trim();
  if (Number.isFinite(Number(changes.instagramOAuthStateExpiresAt))) next.instagramOAuthStateExpiresAt = Number(changes.instagramOAuthStateExpiresAt);
  if (changes.clearInstagramCredentials) { next.instagramAppId = ''; next.instagramAppSecret = ''; }
  if (changes.clearInstagramConnection) {
    next.instagramAccessToken = '';
    next.instagramUserId = '';
    next.instagramUsername = '';
    next.instagramProfilePictureUrl = '';
    next.instagramTokenExpiresAt = 0;
    next.instagramOAuthState = '';
    next.instagramOAuthStateExpiresAt = 0;
  }
  if (
    typeof changes.aiApiKey === 'string' &&
    normalizeApiKey(changes.aiApiKey)
  ) {
    next.aiApiKey = normalizeApiKey(
      changes.aiApiKey
    );
  }

  if (changes.clearAiApiKey) {
    next.aiApiKey = '';
  }

  if (
    typeof changes.geminiApiKey === 'string' &&
    normalizeApiKey(changes.geminiApiKey)
  ) {
    next.geminiApiKey = normalizeApiKey(
      changes.geminiApiKey
    );
  }

  if (changes.clearGeminiApiKey) {
    next.geminiApiKey = '';
  }

  if (
    typeof changes.openaiApiKey === 'string' &&
    normalizeApiKey(changes.openaiApiKey)
  ) {
    next.openaiApiKey = normalizeApiKey(
      changes.openaiApiKey
    );
  }

  if (changes.clearOpenaiApiKey) {
    next.openaiApiKey = '';
  }
  if (typeof changes.extensionIngestToken === 'string' && changes.extensionIngestToken.trim()) next.extensionIngestToken = changes.extensionIngestToken.trim();
  if (changes.clearExtensionIngestToken) next.extensionIngestToken = '';
  if (typeof changes.extensionCouponIngestToken === 'string' && changes.extensionCouponIngestToken.trim()) next.extensionCouponIngestToken = changes.extensionCouponIngestToken.trim();
  if (changes.clearExtensionCouponIngestToken) next.extensionCouponIngestToken = '';
  if (typeof changes.extensionOfferIngestToken === 'string' && changes.extensionOfferIngestToken.trim()) next.extensionOfferIngestToken = changes.extensionOfferIngestToken.trim();
  if (changes.clearExtensionOfferIngestToken) next.extensionOfferIngestToken = '';
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
  const aiApiKey =
    normalizeApiKey(secrets.aiApiKey);

  const geminiApiKey =
    normalizeApiKey(secrets.geminiApiKey);

  const openaiApiKey =
    normalizeApiKey(secrets.openaiApiKey);
  return {
    adminUser: secrets.adminUser,
    adminUsers: normalizeAdminUsers(secrets.adminUsers, process.env.ADMIN_USER || secrets.adminUser).map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions,
      active: user.active !== false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    })),
    adminSetupRequired: !secrets.adminPasswordHash && !process.env.ADMIN_PASSWORD,
    secretsEncryptionKeyExternal: Boolean(environmentEncryptionKey()),
    googleSearchConsoleClientIdConfigured: Boolean(secrets.googleSearchConsoleClientId),
    googleSearchConsoleClientSecretConfigured: Boolean(secrets.googleSearchConsoleClientSecret),
    googleSearchConsoleConnected: Boolean(secrets.googleSearchConsoleAccessToken || secrets.googleSearchConsoleRefreshToken),
    instagramAppIdConfigured: Boolean(secrets.instagramAppId),
    instagramAppSecretConfigured: Boolean(secrets.instagramAppSecret),
    instagramAppId: secrets.instagramAppId || '',
    instagramConnected: Boolean(secrets.instagramAccessToken && secrets.instagramUserId),
    instagramUserId: secrets.instagramUserId || '',
    instagramUsername: secrets.instagramUsername || '',
    instagramProfilePictureUrl: secrets.instagramProfilePictureUrl || '',
    instagramTokenExpiresAt: Number(secrets.instagramTokenExpiresAt || 0),
    mercadoLivreClientIdConfigured: Boolean(secrets.mercadoLivreClientId),
    mercadoLivreClientSecretConfigured: Boolean(secrets.mercadoLivreClientSecret),
    mercadoLivreClientId: secrets.mercadoLivreClientId || '',
    mercadoLivreAccessTokenConfigured: Boolean(secrets.mercadoLivreAccessToken),
    mercadoLivreRefreshTokenConfigured: Boolean(secrets.mercadoLivreRefreshToken),
    mercadoLivreConnected: Boolean(secrets.mercadoLivreAccessToken && (secrets.mercadoLivreRefreshToken || !secrets.mercadoLivreTokenExpiresAt)),
    mercadoLivreTokenExpiresAt: Number(secrets.mercadoLivreTokenExpiresAt || 0),
    mercadoLivreUserId: secrets.mercadoLivreUserId || '',
    mercadoLivreAffiliateCookieConfigured: Boolean(
      secrets.mercadoLivreAffiliateCookie
    ),
    mercadoLivreAffiliateCsrfTokenConfigured: Boolean(
      secrets.mercadoLivreAffiliateCsrfToken
    ),
    mercadoLivreAffiliateTag:
      secrets.mercadoLivreAffiliateTag ||
      process.env.MERCADO_LIVRE_AFFILIATE_TAG ||
      'promoshop',
    shopeeFeedUrlConfigured: Boolean(secrets.shopeeFeedUrl),
    // O feed pode conter parâmetros de autenticação; nunca devolva o URL
    // completo ao navegador administrativo.
    shopeeFeedUrl: secrets.shopeeFeedUrl
      ? (() => { try { return new URL(secrets.shopeeFeedUrl).origin; } catch { return ''; } })()
      : '',
    shopeeAppIdConfigured: Boolean(secrets.shopeeAppId),
    shopeeAppSecretConfigured: Boolean(secrets.shopeeAppSecret),
    shopeeAppId: secrets.shopeeAppId || '',
    aliexpressAppKeyConfigured: Boolean(secrets.aliexpressAppKey),
    aliexpressAppSecretConfigured: Boolean(secrets.aliexpressAppSecret),
    aliexpressAppSignatureConfigured: Boolean(secrets.aliexpressAppSignature),
    aliexpressAppKey: secrets.aliexpressAppKey || '',
    magaluAffiliateIdConfigured: Boolean(secrets.magaluAffiliateId),
    magaluApiKeyConfigured: Boolean(secrets.magaluApiKey),
    magaluAffiliateId: secrets.magaluAffiliateId || '',
    netshoesAffiliateIdConfigured: Boolean(secrets.netshoesAffiliateId),
    netshoesApiKeyConfigured: Boolean(secrets.netshoesApiKey),
    netshoesAffiliateId: secrets.netshoesAffiliateId || '',
    aiApiKeyConfigured: Boolean(aiApiKey),
    aiApiKeyFormatValid: !aiApiKey || (aiApiKey.startsWith('gsk_') && aiApiKey.length >= 20),
    aiApiKeyEnding: aiApiKey ? aiApiKey.slice(-4) : '',
    geminiApiKeyConfigured:
      Boolean(geminiApiKey),

    geminiApiKeyFormatValid:
      !geminiApiKey ||
      geminiApiKey.length >= 20,

    geminiApiKeyEnding:
      geminiApiKey
        ? geminiApiKey.slice(-4)
        : '',

    openaiApiKeyConfigured:
      Boolean(openaiApiKey),

    openaiApiKeyFormatValid:
      !openaiApiKey ||
      openaiApiKey.length >= 20,

    openaiApiKeyEnding:
      openaiApiKey
        ? openaiApiKey.slice(-4)
        : '',
    extensionTokenConfigured: Boolean(secrets.extensionIngestToken),
    extensionTokenEnding: secrets.extensionIngestToken ? String(secrets.extensionIngestToken).slice(-4) : '',
    extensionCouponTokenConfigured: Boolean(secrets.extensionCouponIngestToken || secrets.extensionIngestToken),
    extensionCouponTokenEnding: String(secrets.extensionCouponIngestToken || secrets.extensionIngestToken || '').slice(-4),
    extensionOfferTokenConfigured: Boolean(secrets.extensionOfferIngestToken || secrets.extensionIngestToken),
    extensionOfferTokenEnding: String(secrets.extensionOfferIngestToken || secrets.extensionIngestToken || '').slice(-4)
  };
}
