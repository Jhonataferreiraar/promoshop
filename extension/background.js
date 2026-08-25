const DEFAULT_ENDPOINT = 'https://promoshop.jhonatafaraujo.com.br';

function cleanEndpoint(value) {
  try {
    const url = new URL(String(value || DEFAULT_ENDPOINT).trim());
    return ['https:', 'http:'].includes(url.protocol) ? url.origin.replace(/\/$/, '') : DEFAULT_ENDPOINT;
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
  await fetch(`${settings.endpoint}/api/extension/coupons`, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ token: settings.token, coupons: fresh, allowDuplicate })
  });
  const nextFingerprints = [...known, ...fresh.map(couponFingerprint)].slice(-500);
  await chrome.storage.local.set({ sentFingerprints: nextFingerprints });
  return { sent: fresh.length, duplicates: list.length - fresh.length, message: 'Cupom(ns) enviado(s). Confira a revisão no painel.' };
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
