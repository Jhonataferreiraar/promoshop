(function () {
  'use strict';
  const store = 'Mercado Livre';
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
  const codePattern = /seu código\s*:\s*#?([A-Z0-9][A-Z0-9_-]{3,79})/i;
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
  function generatedCardCandidates() {
    const nodes = [...document.querySelectorAll('*')].filter(visible).filter((element) => codePattern.test(String(element.innerText || '')));
    const leaves = nodes.filter((element) => ![...element.children].some((child) => codePattern.test(String(child.innerText || ''))));
    const candidates = [];
    for (const node of leaves) {
      let card = node;
      for (let level = 0; level < 10 && card.parentElement; level += 1) {
        const parent = card.parentElement;
        const parentText = String(parent.innerText || '').replace(/\s+/g, ' ').trim();
        const codeCount = (parentText.match(/seu código\s*:/gi) || []).length;
        if (codeCount > 1 || parentText.length > 900) break;
        card = parent;
        if (/ver produtos/i.test(parentText) && /\d{1,2}\s*%\s*off/i.test(parentText)) break;
      }
      const text = String(card.innerText || '').replace(/\s+/g, ' ').trim();
      const match = text.match(codePattern);
      if (!match || /\b(inativo|inactive)\b/i.test(text)) continue;
      const code = String(match[1]).toUpperCase();
      const percent = text.match(/(\d{1,2})\s*%\s*off/i);
      const condition = /em produtos selecionados/i.test(text)
        ? 'Em produtos selecionados'
        : 'Condições conforme as regras da loja.';
      const productAnchor = [...card.querySelectorAll('a[href]')].find((anchor) => /ver produtos/i.test(anchor.innerText || ''));
      const firstAnchor = card.querySelector('a[href]');
      const link = productAnchor ? productAnchor.href : firstAnchor ? firstAnchor.href : window.location.href;
      candidates.push({
        title: percent ? `${percent[1]}% OFF` : 'Cupom gerado',
        store,
        code,
        description: condition,
        discountType: 'percent',
        discountValue: percent ? Number(percent[1]) : 0,
        minPurchase: 0,
        expiresAt: null,
        link,
        image: card.querySelector('img[src]') ? card.querySelector('img[src]').src : ''
      });
    }
    return candidates;
  }
  const scan = () => {
    if (!generatedCouponsTabIsActive()) return [];
    const genericCandidates = window.PromoShopCouponScanner && typeof window.PromoShopCouponScanner.scanPage === 'function'
      ? window.PromoShopCouponScanner.scanPage(store)
      : [];
    const generatedCandidates = generatedCardCandidates();
    const candidates = generatedCandidates.length ? generatedCandidates : genericCandidates;
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
