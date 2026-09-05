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

  function productIdFromUrl(value) {
    try {
      const url = new URL(String(value || ''), location.origin);
      for (const key of ['wid', 'item_id', 'itemId']) {
        const candidate = clean(url.searchParams.get(key), 80).match(/MLB(?:U)?-?\d+/i)?.[0];
        if (candidate) return candidate.replace('-', '').toUpperCase();
      }
      return `${url.pathname}${url.search}`.match(/MLB(?:U)?-?\d+/i)?.[0]?.replace('-', '').toUpperCase() || '';
    } catch { return ''; }
  }

  function individualProductPage(data) {
    if (!/(^|\.)mercadolivre\.com\.br$/i.test(location.hostname)) return false;
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    if (productIdFromUrl(location.href) || productIdFromUrl(canonical)) return true;
    const productType = [data?.['@type']].flat().includes('Product');
    const hasTitle = Boolean(document.querySelector('main h1, h1.ui-pdp-title, [itemprop="name"]'));
    const hasPrice = Boolean(document.querySelector('meta[property="product:price:amount"], [itemprop="price"], .ui-pdp-price__main-container'));
    const hasProductShell = Boolean(document.querySelector('.ui-pdp-container, [class*="ui-pdp"], main [data-testid*="product"]'));
    return hasTitle && hasPrice && (productType || hasProductShell);
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
        .find((entry) => visible(entry) && /\bCompartilhar(?:\s+link)?\b/i.test(clean(entry.innerText || entry.getAttribute('aria-label'), 80)));
      if (button) return button;
    }
    return [...document.querySelectorAll('button, [role="button"], a')]
      .find((entry) => visible(entry)
        && /\bCompartilhar(?:\s+link)?\b/i.test(clean(entry.innerText || entry.getAttribute('aria-label'), 80))
        && /\bAfiliados\b/i.test(clean(entry.closest('nav, [role="navigation"], header, aside')?.innerText || '', 1000))) || null;
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
    const data = structuredProduct();
    if (!individualProductPage(data)) {
      throw new Error('Abra uma oferta individual do Mercado Livre. Páginas de busca ou “Ofertas” não geram comissão.');
    }
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
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    const itemLink = [...document.querySelectorAll('a[href*="itemId=MLB"], a[href*="item_id=MLB"]')]
      .map((anchor) => anchor.href.match(/(?:itemId|item_id)=(MLB(?:U)?-?\d+)/i)?.[1]?.replace('-', '').toUpperCase()).find(Boolean);
    const externalId = productIdFromUrl(current.href) || productIdFromUrl(canonical) || itemLink || '';
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

  function productIdFromValue(value) {
    const candidate = String(value || '').match(/\bMLB(?:U)?-?\d+\b/i)?.[0];
    return candidate ? candidate.replace('-', '').toUpperCase() : '';
  }

  function productIdFromLink(url) {
    for (const key of ['item_id', 'itemId', 'wid']) {
      const id = productIdFromValue(url.searchParams.get(key));
      if (id) return id;
    }

    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const filterValues = [
      url.searchParams.get('pdp_filters'),
      hashParams.get('pdp_filters')
    ];
    for (const value of filterValues) {
      const explicit = String(value || '').match(/(?:^|[|;&])(?:item_id|itemId)[:=](MLB(?:U)?-?\d+)/i)?.[1];
      if (explicit) return explicit.replace('-', '').toUpperCase();
    }

    for (const key of ['item_id', 'itemId', 'wid']) {
      const id = productIdFromValue(hashParams.get(key));
      if (id) return id;
    }

    return productIdFromValue(url.pathname);
  }

  function normalizedProductUrl(value) {
    try {
      const url = new URL(String(value || ''), location.origin);
      if (!/(^|\.)mercadolivre\.com\.br$/i.test(url.hostname)) return '';
      if (/\/(?:ofertas?|lista|categoria|search|navigation|home|cupons?)(?:\/|$)/i.test(url.pathname)) return '';

      const productId = productIdFromLink(url);
      if (!productId) return '';
      const trackingLink = /(^|\.)click1\.mercadolivre\.com\.br$/i.test(url.hostname)
        || /\/mclics\/clicks\/external\/MLB\/count/i.test(url.pathname);
      if (trackingLink) return `https://www.mercadolivre.com.br/p/${productId}`;

      url.hash = '';
      [...url.searchParams.keys()].forEach((key) => {
        if (!['wid', 'item_id', 'itemId'].includes(key)) url.searchParams.delete(key);
      });
      return url.toString();
    } catch {
      return '';
    }
  }

  function productCardFor(anchor) {
    let current = anchor;
    for (let level = 0; level < 8 && current; level += 1) {
      const className = String(current.className || '').toLowerCase();
      if (current.matches?.('li, article, [data-testid*="poly-card"], [class*="poly-card"], [class*="ui-search-result"]')
        || /poly-card|ui-search-result|search-item/.test(className)) return current;
      current = current.parentElement;
    }
    return anchor.parentElement || anchor;
  }

  function textFromCard(card, selectors) {
    for (const selector of selectors) {
      const node = card.querySelector(selector);
      const text = clean(node?.textContent || node?.getAttribute?.('aria-label') || '', 300);
      if (text) return text;
    }
    return '';
  }

  function productCandidates() {
    const data = structuredProduct();
    if (individualProductPage(data)) {
      const url = normalizedProductUrl(location.href) || normalizedProductUrl(document.querySelector('link[rel="canonical"]')?.href);
      if (!url) return [];
      const pageText = clean(document.body?.innerText, 12000);
      return [{
        url,
        title: clean(document.querySelector('h1')?.textContent || data.name || document.title, 300),
        discount: Number(pageText.match(/\b(\d{1,2})%\s*OFF\b/i)?.[1] || 0),
        image: clean(document.querySelector('meta[property="og:image"]')?.content || (Array.isArray(data.image) ? data.image[0] : data.image) || '', 2000)
      }];
    }

    const seen = new Set();
    const products = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = normalizedProductUrl(anchor.href);
      if (!url || seen.has(url)) continue;
      const card = productCardFor(anchor);
      const cardText = clean(card.innerText || '', 1600);
      const title = textFromCard(card, [
        'h2', 'h3', '[data-testid*="title"]', '[class*="poly-component__title"]',
        '[class*="ui-search-item__title"]', '[class*="title"]'
      ]) || clean(anchor.getAttribute('aria-label') || anchor.title || '', 300) || 'Produto Mercado Livre';
      const imageNode = card.querySelector('img[src], img[data-src]');
      const image = clean(imageNode?.src || imageNode?.getAttribute('data-src') || '', 2000);
      const discount = Number(cardText.match(/\b(\d{1,2})%\s*OFF\b/i)?.[1] || 0);
      seen.add(url);
      products.push({ url, title, discount, image });
    }
    return products;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SCAN_ML_PRODUCTS') {
      try {
        if (!/(^|\.)mercadolivre\.com\.br$/i.test(location.hostname)) throw new Error('Abra uma página do Mercado Livre para ler os produtos.');
        sendResponse({ products: productCandidates() });
      } catch (error) {
        sendResponse({ error: error.message || 'Não foi possível ler esta página.' });
      }
      return true;
    }
    if (message?.type !== 'CAPTURE_ML_OFFER') return false;
    captureOffer().then((offer) => sendResponse({ offer })).catch((error) => sendResponse({ error: error.message }));
    return true;
  });
})();
