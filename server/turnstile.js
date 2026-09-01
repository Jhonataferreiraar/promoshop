import crypto from 'node:crypto';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 2_048;

function configuredValue(name) {
  return String(process.env[name] || '').trim();
}

export function turnstileSiteKey() {
  return configuredValue('TURNSTILE_SITE_KEY');
}

export function turnstileSecretKey() {
  return configuredValue('TURNSTILE_SECRET_KEY') || configuredValue('CLOUDFLARE_TURNSTILE_SECRET_KEY');
}

export function turnstileEnabled() {
  return Boolean(turnstileSiteKey() && turnstileSecretKey());
}

export function turnstilePublicConfig() {
  const siteKey = turnstileSiteKey();
  return {
    turnstileEnabled: Boolean(siteKey && turnstileSecretKey()),
    // A site key is public by design. Never expose the secret key here.
    turnstileSiteKey: siteKey
  };
}

function normalizedHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/:\d+$/, '');
}

function validationFailure(errorCodes = []) {
  return {
    success: false,
    errorCodes: Array.from(new Set(errorCodes.map((code) => String(code || '').trim()).filter(Boolean)))
  };
}

/**
 * Validates a browser-issued Turnstile token on the server.
 * The secret never leaves this module and the full Siteverify response is not
 * returned to callers, so Cloudflare details cannot leak through the API.
 */
export async function verifyTurnstileToken(token, {
  remoteIp = '',
  expectedAction = '',
  expectedHostname = ''
} = {}) {
  const secret = turnstileSecretKey();
  const response = String(token || '').trim();
  if (!secret) return validationFailure(['not-configured']);
  if (!response) return validationFailure(['missing-input-response']);
  if (response.length > MAX_TOKEN_LENGTH) return validationFailure(['invalid-input-response']);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const payload = {
      secret,
      response,
      idempotency_key: crypto.randomUUID()
    };
    if (remoteIp) payload.remoteip = String(remoteIp).slice(0, 128);

    const validationResponse = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const result = await validationResponse.json().catch(() => null);
    if (!validationResponse.ok || !result || typeof result !== 'object') {
      return validationFailure(['siteverify-unavailable']);
    }

    const errorCodes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
    if (result.success !== true) return validationFailure(errorCodes.length ? errorCodes : ['invalid-input-response']);

    if (expectedAction && String(result.action || '') !== String(expectedAction)) {
      return validationFailure(['action-mismatch']);
    }

    if (expectedHostname && normalizedHostname(result.hostname) !== normalizedHostname(expectedHostname)) {
      return validationFailure(['hostname-mismatch']);
    }

    return {
      success: true,
      action: String(result.action || ''),
      hostname: String(result.hostname || '')
    };
  } catch (error) {
    if (error?.name === 'AbortError') return validationFailure(['timeout']);
    return validationFailure(['internal-error']);
  } finally {
    clearTimeout(timeout);
  }
}

