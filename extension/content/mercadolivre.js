(function () {
  const store = 'Mercado Livre';
  const scan = () => window.PromoShopCouponScanner?.scanPage(store) || [];
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => { if (message?.type !== 'SCAN_COUPONS') return false; sendResponse({ coupons: scan(), store }); return true; });
  let timer;
  const report = () => { clearTimeout(timer); timer = setTimeout(() => chrome.runtime.sendMessage({ type: 'AUTO_COUPONS', coupons: scan() }).catch(() => {}), 1200); };
  new MutationObserver(report).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(report, 1800);
})();
