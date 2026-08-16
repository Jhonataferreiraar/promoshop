import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-ml-oauth-'));
process.env.DATA_DIR = testDataDir;

try {
  const { readSecrets, secretStatus, updateSecrets } = await import('../server/secrets.js');
  const { beginMercadoLivreAuthorization, finishMercadoLivreAuthorization } = await import('../server/mercadolivre.js');
  await updateSecrets({ mercadoLivreClientId: '123456', mercadoLivreClientSecret: 'secret-for-test' });
  const redirectUri = 'https://example.com/api/mercadolivre/callback';
  const authorizationUrl = new URL(await beginMercadoLivreAuthorization(redirectUri));
  assert.equal(authorizationUrl.hostname, 'auth.mercadolivre.com.br');
  assert.equal(authorizationUrl.searchParams.get('client_id'), '123456');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  const state = authorizationUrl.searchParams.get('state');
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'APP_USR-test',
    refresh_token: 'TG-test',
    expires_in: 21600,
    user_id: 987654
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const updated = await finishMercadoLivreAuthorization({ code: 'authorization-code', state });
  const status = secretStatus(updated);
  assert.equal(status.mercadoLivreConnected, true);
  assert.equal(status.mercadoLivreUserId, '987654');
  assert.equal((await readSecrets()).mercadoLivreOAuthState, '');
  console.log('Fluxo OAuth do Mercado Livre validado.');
} finally {
  await fs.rm(testDataDir, { recursive: true, force: true });
}
