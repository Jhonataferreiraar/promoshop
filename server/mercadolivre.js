import crypto from 'node:crypto';
import { readSecrets, updateSecrets } from './secrets.js';

const tokenEndpoint = 'https://api.mercadolibre.com/oauth/token';
let refreshPromise = null;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function tokenError(payload, status) {
  const detail = payload?.message || payload?.error_description || payload?.error || `status ${status}`;
  return new Error(`Mercado Livre recusou a autorização: ${detail}`);
}

async function requestToken(fields) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw tokenError(payload, response.status);
  return payload;
}

async function saveToken(payload) {
  return updateSecrets({
    mercadoLivreAccessToken: payload.access_token,
    mercadoLivreRefreshToken: payload.refresh_token || '',
    mercadoLivreTokenExpiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 21600)) * 1000,
    mercadoLivreUserId: payload.user_id || '',
    mercadoLivreOAuthState: '',
    mercadoLivreOAuthStateExpiresAt: 0,
    mercadoLivreCodeVerifier: '',
    mercadoLivreOAuthRedirectUri: ''
  });
}

export async function beginMercadoLivreAuthorization(redirectUri) {
  const secrets = await readSecrets();
  if (!secrets.mercadoLivreClientId || !secrets.mercadoLivreClientSecret) {
    throw new Error('Informe o Client ID e o Client Secret do Mercado Livre no painel.');
  }
  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  await updateSecrets({
    mercadoLivreOAuthState: state,
    mercadoLivreOAuthStateExpiresAt: Date.now() + 10 * 60 * 1000,
    mercadoLivreCodeVerifier: codeVerifier,
    mercadoLivreOAuthRedirectUri: redirectUri
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: secrets.mercadoLivreClientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  return `https://auth.mercadolivre.com.br/authorization?${params}`;
}

export async function finishMercadoLivreAuthorization({ code, state }) {
  const secrets = await readSecrets();
  if (!code || !state || !secrets.mercadoLivreOAuthState || state !== secrets.mercadoLivreOAuthState || Number(secrets.mercadoLivreOAuthStateExpiresAt || 0) < Date.now()) {
    throw new Error('A autorização retornou com um código de segurança inválido ou expirado.');
  }
  const payload = await requestToken({
    grant_type: 'authorization_code',
    client_id: secrets.mercadoLivreClientId,
    client_secret: secrets.mercadoLivreClientSecret,
    code,
    redirect_uri: secrets.mercadoLivreOAuthRedirectUri,
    code_verifier: secrets.mercadoLivreCodeVerifier
  });
  return saveToken(payload);
}

export async function getMercadoLivreAccessToken() {
  const secrets = await readSecrets();
  const environmentToken = String(process.env.MERCADO_LIVRE_ACCESS_TOKEN || '').trim();
  if (!secrets.mercadoLivreAccessToken) return environmentToken;
  const expiresAt = Number(secrets.mercadoLivreTokenExpiresAt || 0);
  if (!expiresAt || expiresAt > Date.now() + 60_000) return secrets.mercadoLivreAccessToken;
  if (!secrets.mercadoLivreRefreshToken || !secrets.mercadoLivreClientId || !secrets.mercadoLivreClientSecret) {
    return secrets.mercadoLivreAccessToken;
  }
  if (!refreshPromise) {
    refreshPromise = requestToken({
      grant_type: 'refresh_token',
      client_id: secrets.mercadoLivreClientId,
      client_secret: secrets.mercadoLivreClientSecret,
      refresh_token: secrets.mercadoLivreRefreshToken
    }).then(saveToken).then((updated) => updated.mercadoLivreAccessToken).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export async function validateMercadoLivreConnection() {
  const token = await getMercadoLivreAccessToken();
  if (!token) throw new Error('Conecte sua conta do Mercado Livre primeiro.');
  const response = await fetch('https://api.mercadolibre.com/users/me', {
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `API respondeu com status ${response.status}`);
  return payload;
}
