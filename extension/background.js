const DEFAULT_ENDPOINT = 'https://promoshop.jhonatafaraujo.com.br';

function cleanEndpoint(value) {
  try {
    const url = new URL(String(value || DEFAULT_ENDPOINT).trim());
    const localDevelopment = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'https:' || localDevelopment ? url.origin.replace(/\/$/, '') : DEFAULT_ENDPOINT;
  } catch { return DEFAULT_ENDPOINT; }
}

function couponFingerprint(coupon) {
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${normalize(coupon.store)}|${normalize(coupon.code) || String(coupon.link || '').replace(/[?#].*$/, '').toLowerCase()}`;
}

async function getSettings() {
  const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: '', autoSend: false, sentFingerprints: [] });
  return { ...settings, endpoint: cleanEndpoint(settings.endpoint) };
}

async function sendCoupons(coupons, { allowDuplicate = false } = {}) {
  const settings = await getSettings();
  if (!settings.token) throw new Error('Informe o token da extensão no popup.');
  const list = (Array.isArray(coupons) ? coupons : [coupons]).filter(Boolean).slice(0, 50);
  if (!list.length) throw new Error('Nenhum cupom encontrado na página.');
  const known = new Set(settings.sentFingerprints || []);
  const fresh = allowDuplicate ? list : list.filter((coupon) => !known.has(couponFingerprint(coupon)));
  if (!fresh.length) return { sent: 0, duplicates: list.length, message: 'Estes cupons já foram enviados.' };
  const response = await fetch(`${settings.endpoint}/api/extension/coupons`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-promoshop-extension-token': settings.token
    },
    body: JSON.stringify({ coupons: fresh, allowDuplicate })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.errors?.join(' · ') || `O PromoShop recusou o envio (${response.status}).`);
  }
  const accepted = new Set(Array.isArray(payload.acceptedFingerprints) ? payload.acceptedFingerprints : []);
  const acceptedCoupons = fresh.filter((coupon) => accepted.has(couponFingerprint(coupon)));
  if (!acceptedCoupons.length) throw new Error(payload.errors?.join(' · ') || 'Nenhum cupom foi aceito pelo PromoShop.');
  const nextFingerprints = [...known, ...acceptedCoupons.map(couponFingerprint)].slice(-500);
  await chrome.storage.local.set({ sentFingerprints: nextFingerprints });
  return {
    sent: acceptedCoupons.length,
    duplicates: Number(payload.duplicates?.length || 0) + list.length - fresh.length,
    rejected: fresh.length - acceptedCoupons.length,
    message: 'Cupom(ns) confirmado(s) pelo PromoShop. Confira a revisão no painel.'
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SEND_COUPONS' && message?.type !== 'AUTO_COUPONS') return false;
  (async () => {
    const settings = await getSettings();
    if (message.type === 'AUTO_COUPONS' && settings.autoSend !== true) return { sent: 0, skipped: true };
    return sendCoupons(message.coupons || [], { allowDuplicate: message.allowDuplicate === true });
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message || 'Não foi possível enviar.' }));
  return true;
});
