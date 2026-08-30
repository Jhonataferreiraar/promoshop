import { normalizeSearchText } from './searchRelevance.js';

export const WHATSAPP_STORE_PRIORITY = Object.freeze([
  'Mercado Livre',
  'Shopee',
  'AliExpress',
  'Magalu'
]);

function normalizedStore(value) {
  return normalizeSearchText(value).replace(/\s+/g, ' ').trim();
}

function storeForQueueItem(item, offers = []) {
  const offer = Array.isArray(offers)
    ? offers.find((entry) => String(entry?.id || '') === String(item?.offerId || ''))
    : null;
  return item?.store || item?.offerSnapshot?.store || item?.couponSnapshot?.store || offer?.store || '';
}

export function normalizeWhatsappStorePriorityCursor(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return 0;
  return ((numeric % WHATSAPP_STORE_PRIORITY.length) + WHATSAPP_STORE_PRIORITY.length) % WHATSAPP_STORE_PRIORITY.length;
}

export function whatsappStorePriorityIndex(item, offers = []) {
  const store = normalizedStore(storeForQueueItem(item, offers));
  return WHATSAPP_STORE_PRIORITY.findIndex((entry) => normalizedStore(entry) === store);
}

export function prioritizeWhatsappCandidates(candidates, offers = [], cursor = 0) {
  const start = normalizeWhatsappStorePriorityCursor(cursor);
  const storeOrder = Array.from(
    { length: WHATSAPP_STORE_PRIORITY.length },
    (_, offset) => (start + offset) % WHATSAPP_STORE_PRIORITY.length
  );
  const buckets = storeOrder.map(() => []);
  const remaining = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const index = whatsappStorePriorityIndex(candidate, offers);
    const bucket = storeOrder.indexOf(index);
    if (bucket >= 0) buckets[bucket].push(candidate);
    else remaining.push(candidate);
  }

  return [...buckets.flat(), ...remaining];
}

export function nextWhatsappStorePriorityCursor(item, offers = [], currentCursor = 0) {
  const selectedIndex = whatsappStorePriorityIndex(item, offers);
  return selectedIndex >= 0
    ? (selectedIndex + 1) % WHATSAPP_STORE_PRIORITY.length
    : normalizeWhatsappStorePriorityCursor(currentCursor);
}
