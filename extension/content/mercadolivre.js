(function () {
  'use strict';
  const store = 'Mercado Livre';
  const scan = () => window.PromoShopCouponScanner && typeof window.PromoShopCouponScanner.scanPage === 'function'
    ? window.PromoShopCouponScanner.scanPage(store)
    : [];
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
