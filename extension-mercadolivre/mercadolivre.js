(function () {
  'use strict';
  const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));

  function numberFromBrazilian(value) {
    const text = clean(value, 80);
    const spoken = text.match(/(\d[\d.]*)\s*reais?(?:\s+com\s+(\d{1,2})\s*centavos?)?/i);
    if (spoken) return Number(spoken[1].replace(/\./g, '')) + Number(spoken[2] || 0) / 100;
    const normalized = text.replace(/[^\d.,]/g, '');
    if (!normalized) return 0;
    const parsed = normalized.includes(',') ? normalized.replace(/\./g, '').replace(',', '.') : normalized;
    return Number(parsed) || 0;
  }

  function structuredProduct() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(script.textContent || '{}');
        const entries = Array.isArray(value) ? value : value['@graph'] || [value];
        const product = entries.find((entry) => [entry?.['@type']].flat().includes('Product'));
        if (product) return product;
      } catch {}
    }
    return {};
  }

  function affiliateLink() {
    return [...document.querySelectorAll('input, textarea')]
      .map((input) => clean(input.value, 1000))
      .find((value) => /^https:\/\/meli\.la\/[A-Za-z0-9_-]+$/i.test(value)) || '';
  }

  function affiliateShareButton() {
    const regions = [...document.querySelectorAll('nav, [role="navigation"]')]
      .filter((node) => /\bAfiliados\b/i.test(clean(node.innerText, 1000)));
    for (const region of regions) {
      const button = [...region.querySelectorAll('button')]
        .find((entry) => visible(entry) && /^Compartilhar$/i.test(clean(entry.innerText || entry.getAttribute('aria-label'), 80)));
      if (button) return button;
    }
    return null;
  }

  async function ensureAffiliateLink() {
    const existing = affiliateLink();
    if (existing) return existing;
    const button = affiliateShareButton();
    if (!button) throw new Error('Ative a Barra de Afiliados do Mercado Livre e abra uma página individual de produto.');
    button.click();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const generated = affiliateLink();
      if (generated) return generated;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('O Mercado Livre não concluiu a geração do link. Feche a janela de compartilhamento e tente novamente.');
  }

  function originalPriceFromPage(price, discount) {
    const selectors = ['[aria-label^="Antes:"]', '.ui-pdp-price__original-value', '[class*="original-price"]', 's'];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const value = numberFromBrazilian(node.getAttribute('aria-label') || node.textContent);
        if (value > price) return value;
      }
    }
    return discount > 0 && discount < 96 ? price / (1 - discount / 100) : 0;
  }

  async function captureOffer() {
    if (!/mercadolivre\.com\.br$/i.test(location.hostname) || !/(\/p\/MLB\d+|MLB-\d+)/i.test(`${location.pathname}${location.search}`)) {
      throw new Error('Abra uma oferta individual do Mercado Livre. Páginas de busca ou “Ofertas” não geram comissão.');
    }
    const data = structuredProduct();
    const title = clean(document.querySelector('h1')?.textContent || data.name || document.title, 300);
    const metaPrice = document.querySelector('meta[property="product:price:amount"]')?.content;
    const itemPrice = document.querySelector('[itemprop="price"][content]')?.getAttribute('content');
    const fraction = document.querySelector('.ui-pdp-price__second-line .andes-money-amount__fraction, .ui-pdp-price__main-container .andes-money-amount__fraction')?.textContent;
    const price = numberFromBrazilian(metaPrice || itemPrice || data.offers?.price || fraction);
    const pageText = clean(document.body?.innerText, 12000);
    const discount = Number(pageText.match(/\b(\d{1,2})%\s*OFF\b/i)?.[1] || 0);
    const originalPrice = originalPriceFromPage(price, discount);
    const structuredImage = Array.isArray(data.image) ? data.image[0] : data.image;
    const image = clean(document.querySelector('meta[property="og:image"]')?.content || structuredImage || document.querySelector('main img[src]')?.src, 2000);
    const current = new URL(location.href);
    const itemLink = [...document.querySelectorAll('a[href*="itemId=MLB"], a[href*="item_id=MLB"]')]
      .map((anchor) => anchor.href.match(/(?:itemId|item_id)=(MLB\d+)/i)?.[1]).find(Boolean);
    const externalId = current.searchParams.get('wid') || current.searchParams.get('item_id') || itemLink || `${current.pathname}${current.search}`.match(/MLB-?\d+/i)?.[0]?.replace('-', '') || '';
    current.hash = '';
    ['polycard_client', 'deal_print_id', 'position', 'tracking_id', 'sid'].forEach((key) => current.searchParams.delete(key));
    if (!title || !(price > 0) || !(originalPrice > price) || !discount) throw new Error('Esta página não apresenta preço e desconto válidos para importar como promoção.');
    if (!/^https:\/\//i.test(image)) throw new Error('A imagem principal da oferta não foi encontrada.');
    const link = await ensureAffiliateLink();
    return {
      externalId,
      title,
      store: 'Mercado Livre',
      category: clean(document.querySelector('main nav a:last-of-type')?.textContent || 'Mercado Livre', 100),
      price,
      originalPrice: Number(originalPrice.toFixed(2)),
      discount,
      image,
      productUrl: current.toString(),
      affiliateUrl: link,
      freeShipping: /frete gr[aá]tis/i.test(pageText)
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CAPTURE_ML_OFFER') return false;
    captureOffer().then((offer) => sendResponse({ offer })).catch((error) => sendResponse({ error: error.message }));
    return true;
  });
})();
