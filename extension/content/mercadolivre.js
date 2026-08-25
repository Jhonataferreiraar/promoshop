(function () {
  'use strict';
  const store = 'Mercado Livre';
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
  function generatedCouponsTabIsActive() {
    const bodyText = normalized(document.body && document.body.innerText);
    if (!bodyText.includes('seu código:')) return false;
    const tabs = [...document.querySelectorAll('[role="tab"], button, a, [class*="tab"], [data-testid]')]
      .filter(visible)
      .filter((element) => normalized(element.innerText || element.textContent) === 'códigos gerados');
    if (!tabs.length) return true;
    const tab = tabs[0];
    const ariaSelected = tab.getAttribute('aria-selected');
    if (ariaSelected === 'true') return true;
    if (ariaSelected === 'false') return false;
    const parentClass = tab.parentElement ? tab.parentElement.className : '';
    const classes = `${String(tab.className || '')} ${String(parentClass || '')}`.toLowerCase();
    if (/active|selected|current/.test(classes)) return true;
    return true;
  }
  const scan = () => {
    if (!generatedCouponsTabIsActive()) return [];
    const candidates = window.PromoShopCouponScanner && typeof window.PromoShopCouponScanner.scanPage === 'function'
      ? window.PromoShopCouponScanner.scanPage(store)
      : [];
    const seenCodes = new Set();
    return candidates.filter((candidate) => {
      const code = String(candidate.code || '').trim().toUpperCase();
      const description = String(candidate.description || '');
      if (!code || /\b(inativo|inactive)\b/i.test(description)) return false;
      if (seenCodes.has(code)) return false;
      seenCodes.add(code);
      return true;
    });
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'SCAN_COUPONS') return false;
    sendResponse({ coupons: scan(), store });
    return true;
  });
  let timer;
  const report = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const result = chrome.runtime.sendMessage({ type: 'AUTO_COUPONS', coupons: scan() });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }, 1200);
  };
  new MutationObserver(report).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(report, 1800);
})();
