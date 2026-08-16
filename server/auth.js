import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecrets } from './secrets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSessionSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
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

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function signature(payload) { return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url'); }

export function createToken(username) {
  const payload = base64url(JSON.stringify({ username, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }));
  return `${payload}.${signature(payload)}`;
}

export function validateToken(token) {
  if (!token?.includes('.')) return false;
  const [payload, provided] = token.split('.');
  const expected = signature(payload);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).expiresAt > Date.now(); }
  catch { return false; }
}

export function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!validateToken(token)) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  next();
}

export async function requireWorker(req, res, next) {
  const stored = await readSecrets();
  const expected = process.env.WORKER_TOKEN || stored.workerToken || '';
  const provided = req.headers['x-worker-token'] || '';
  if (!expected || expected.length !== provided.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return res.status(401).json({ error: 'Publicador não autorizado.' });
  next();
}
