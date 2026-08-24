(function () {
  const ignoredCodes = new Set(['CUPOM', 'DESCONTO', 'PROMO', 'OFFER', 'SHOP', 'SALE', 'CODE', 'USE']);
  const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  function firstText(element, selectors) {
    for (const selector of selectors) {
      const value = clean(element?.querySelector(selector)?.textContent, 180);
      if (value) return value;
    }
    return '';
  }
  function extractCode(text) {
    const match = clean(text, 1200).match(/(?:c[oó]digo|cupom|use|utilize)\s*[:\-]?\s*([A-Z0-9][A-Z0-9_-]{3,24})/i);
    const code = String(match?.[1] || '').toUpperCase();
    return code && !ignoredCodes.has(code) ? code : '';
  }
  function extractDiscount(text) {
    const percent = clean(text, 1200).match(/(\d{1,2})\s*%\s*(?:off|de desconto|desconto)?/i);
    if (percent) return { discountType: 'percent', discountValue: Number(percent[1]) };
    const fixed = clean(text, 1200).match(/R\$\s*([\d.,]+)\s*(?:off|de desconto)/i);
    if (fixed) return { discountType: 'fixed', discountValue: Number(fixed[1].replace(/\./g, '').replace(',', '.')) || 0 };
    return { discountType: 'percent', discountValue: 0 };
  }
  function extractExpiry(text) {
    const match = clean(text, 1200).match(/(?:at[eé]|válido até|expira em)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/i);
    if (!match) return null;
    const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(new Date().getFullYear());
    const date = new Date(`${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}T23:59:59`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  function candidateFromElement(element, store) {
    const text = clean(element?.innerText || element?.textContent, 1200);
    if (!text || !/(cupom|c[oó]digo|desconto|voucher|off)/i.test(text)) return null;
    const link = element?.closest('a')?.href || element?.querySelector('a[href]')?.href || window.location.href;
    const image = element?.querySelector('img[src]')?.src || '';
    const title = firstText(element, ['h1', 'h2', 'h3', 'h4', '[class*="title"]', '[class*="name"]']) || clean(document.title, 180);
    const discount = extractDiscount(text);
    return { title, store, code: extractCode(text), description: clean(text, 500), ...discount, minPurchase: 0, expiresAt: extractExpiry(text), link, image };
  }
  function scanPage(store) {
    const selectors = ['[class*="coupon"]', '[class*="cupom"]', '[class*="voucher"]', '[data-testid*="coupon"]', '[data-testid*="voucher"]', 'button', 'a'];
    const elements = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
    const candidates = elements.map((element) => candidateFromElement(element, store)).filter(Boolean);
    if (!candidates.length) {
      const fallbackText = clean(document.body?.innerText, 1000);
      if (/(cupom|c[oó]digo|desconto|voucher|off)/i.test(fallbackText)) {
        const discount = extractDiscount(fallbackText);
        candidates.push({ title: clean(document.title, 180), store, code: extractCode(fallbackText), description: fallbackText.slice(0, 500), ...discount, minPurchase: 0, expiresAt: extractExpiry(fallbackText), link: window.location.href, image: document.querySelector('img[src]')?.src || '' });
      }
    }
    const seen = new Set();
    return candidates.filter((candidate) => { const key = `${candidate.store}|${candidate.code}|${candidate.link}|${candidate.title}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 10);
  }
  window.PromoShopCouponScanner = { scanPage };
})();
