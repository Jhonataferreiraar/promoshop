import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecrets } from './secrets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSessionSecret() {
  if (String(process.env.AUTH_SECRET || '').length >= 32) return process.env.AUTH_SECRET;
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
  const secretFile = path.join(dataDir, '.auth-secret');
  try {
    const saved = fs.readFileSync(secretFile, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

const sessionSecret = loadSessionSecret();
const legacySessionCookieName = 'promoshop_session';
const legacyCsrfCookieName = 'promoshop_csrf';
const sessionCookieName = process.env.NODE_ENV === 'production' ? '__Host-promoshop_session' : legacySessionCookieName;
const csrfCookieName = process.env.NODE_ENV === 'production' ? '__Host-promoshop_csrf' : legacyCsrfCookieName;
const sessionMaxAgeSeconds = 12 * 60 * 60;

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function signature(payload) { return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url'); }

export function hashSecurityIdentifier(value) {
  return crypto.createHmac('sha256', sessionSecret)
    .update('security-identifier\0')
    .update(String(value || 'unknown'))
    .digest('hex');
}

function parseCookies(header = '') {
  return String(header || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) return cookies;
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
    return cookies;
  }, {});
}

function secureCookies() {
  return process.env.NODE_ENV === 'production';
}

function cookieHeader(name, value, options = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    `Max-Age=${Number.isFinite(options.maxAge) ? options.maxAge : sessionMaxAgeSeconds}`,
    `SameSite=${options.sameSite || 'Lax'}`
  ];
  if (options.httpOnly) attributes.push('HttpOnly');
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function setSessionCookies(res, token) {
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const secure = secureCookies();
  res.append('Set-Cookie', cookieHeader(sessionCookieName, token, { httpOnly: true, secure }));
  res.append('Set-Cookie', cookieHeader(csrfCookieName, csrfToken, { secure }));
  if (secure) {
    res.append('Set-Cookie', cookieHeader(legacySessionCookieName, '', { httpOnly: true, secure, maxAge: 0 }));
    res.append('Set-Cookie', cookieHeader(legacyCsrfCookieName, '', { secure, maxAge: 0 }));
  }
  return csrfToken;
}

export function clearSessionCookies(res) {
  const secure = secureCookies();
  res.append('Set-Cookie', cookieHeader(sessionCookieName, '', { httpOnly: true, secure, maxAge: 0 }));
  res.append('Set-Cookie', cookieHeader(csrfCookieName, '', { secure, maxAge: 0 }));
  if (secure) {
    res.append('Set-Cookie', cookieHeader(legacySessionCookieName, '', { httpOnly: true, secure, maxAge: 0 }));
    res.append('Set-Cookie', cookieHeader(legacyCsrfCookieName, '', { secure, maxAge: 0 }));
  }
}

function sessionTokenFromRequest(req) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return { token: bearer, fromCookie: false };
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[sessionCookieName] || cookies[legacySessionCookieName] || '';
  return { token, fromCookie: Boolean(token), cookies };
}

function csrfValid(req, cookies = parseCookies(req.headers.cookie)) {
  const cookieToken = String(cookies[csrfCookieName] || cookies[legacyCsrfCookieName] || '');
  const headerToken = String(req.headers['x-csrf-token'] || '');
  return Boolean(cookieToken) && cookieToken.length === headerToken.length && crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
}

export function createToken(username, sessionVersion = 0) {
  const payload = base64url(JSON.stringify({ username, sessionVersion: Number(sessionVersion || 0), expiresAt: Date.now() + 12 * 60 * 60 * 1000 }));
  return `${payload}.${signature(payload)}`;
}

export function validateToken(token, expectedSessionVersion = 0) {
  if (!token?.includes('.')) return false;
  const [payload, provided] = token.split('.');
  const expected = signature(payload);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return decoded.expiresAt > Date.now() && Number(decoded.sessionVersion || 0) === Number(expectedSessionVersion || 0);
  }
  catch { return false; }
}

export async function requireAdmin(req, res, next) {
  const session = sessionTokenFromRequest(req);
  const secrets = await readSecrets();
  if (!validateToken(session.token, secrets.adminSessionVersion)) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  if (session.fromCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfValid(req, session.cookies)) {
    return res.status(403).json({ error: 'Proteção CSRF inválida. Atualize a página e tente novamente.' });
  }
  req.adminUser = session.token;
  next();
}

export async function requireWorker(req, res, next) {
  const stored = await readSecrets();
  const expected = process.env.WORKER_TOKEN || stored.workerToken || '';
  const provided = req.headers['x-worker-token'] || '';
  if (expected.length < 32 || expected.length !== String(provided).length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(provided)))) return res.status(401).json({ error: 'Publicador não autorizado.' });
  next();
}
