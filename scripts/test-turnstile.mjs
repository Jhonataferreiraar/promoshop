import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const previous = {
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
  CLOUDFLARE_TURNSTILE_SECRET_KEY: process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY
};
const originalFetch = globalThis.fetch;

try {
  const testTurnstileSecret = randomBytes(18).toString('hex');
  process.env.TURNSTILE_SITE_KEY = 'turnstile-example-site-key';
  process.env.TURNSTILE_SECRET_KEY = testTurnstileSecret;
  delete process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;

  const turnstile = await import(`../server/turnstile.js?test=${Date.now()}`);
  assert.equal(turnstile.turnstileEnabled(), true);
  assert.deepEqual(turnstile.turnstilePublicConfig(), {
    turnstileEnabled: true,
    turnstileSiteKey: 'turnstile-example-site-key'
  });

  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      success: true,
      action: 'admin-login',
      hostname: 'promoshop.jhonatafaraujo.com.br'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const valid = await turnstile.verifyTurnstileToken('token-for-test', {
    remoteIp: '127.0.0.1',
    expectedAction: 'admin-login',
    expectedHostname: 'promoshop.jhonatafaraujo.com.br'
  });
  assert.equal(valid.success, true);
  assert.equal(Object.hasOwn(valid, 'secret'), false);
  assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.ok(request.options.body.includes(`"secret":"${testTurnstileSecret}"`));
  assert.match(request.options.body, /"response":"token-for-test"/);
  assert.match(request.options.body, /"remoteip":"127\.0\.0\.1"/);
  assert.match(request.options.body, /"idempotency_key":"[^"]+"/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    action: 'different-action',
    hostname: 'promoshop.jhonatafaraujo.com.br'
  }), { status: 200 });
  const wrongAction = await turnstile.verifyTurnstileToken('token-for-test', {
    expectedAction: 'admin-login',
    expectedHostname: 'promoshop.jhonatafaraujo.com.br'
  });
  assert.deepEqual(wrongAction, { success: false, errorCodes: ['action-mismatch'] });

  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    action: 'admin-login',
    hostname: 'outro.example'
  }), { status: 200 });
  const wrongHostname = await turnstile.verifyTurnstileToken('token-for-test', {
    expectedAction: 'admin-login',
    expectedHostname: 'promoshop.jhonatafaraujo.com.br'
  });
  assert.deepEqual(wrongHostname, { success: false, errorCodes: ['hostname-mismatch'] });

  const missing = await turnstile.verifyTurnstileToken('', { expectedAction: 'admin-login' });
  assert.deepEqual(missing, { success: false, errorCodes: ['missing-input-response'] });

  process.env.TURNSTILE_SECRET_KEY = '';
  assert.equal(turnstile.turnstileEnabled(), false);
  assert.deepEqual(turnstile.turnstilePublicConfig(), {
    turnstileEnabled: false,
    turnstileSiteKey: 'turnstile-example-site-key'
  });
  console.log('Turnstile: configuração pública, token, ação, hostname e modo desativado validados.');
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
