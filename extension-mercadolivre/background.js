const DEFAULT_ENDPOINT = 'https://promoshop.jhonatafaraujo.com.br';

function cleanEndpoint(value) {
  try {
    const url = new URL(String(value || DEFAULT_ENDPOINT).trim());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'https:' || local ? url.origin.replace(/\/$/, '') : DEFAULT_ENDPOINT;
  } catch { return DEFAULT_ENDPOINT; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SEND_ML_OFFER') return false;
  (async () => {
    const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: '' });
    if (!settings.token) throw new Error('Informe o token da extensão.');
    const response = await fetch(`${cleanEndpoint(settings.endpoint)}/api/extension/mercadolivre/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-promoshop-extension-token': settings.token },
      body: JSON.stringify({ offers: [message.offer] })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.errors?.join(' · ') || `O PromoShop recusou o envio (${response.status}).`);
    const result = payload.imported?.[0];
    return { ok: true, message: result?.updated ? 'Oferta atualizada no PromoShop, sem duplicar.' : 'Oferta adicionada ao PromoShop.' };
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message || 'Não foi possível enviar a oferta.' }));
  return true;
});
