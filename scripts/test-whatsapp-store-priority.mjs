import assert from 'node:assert/strict';
import {
  nextWhatsappStorePriorityCursor,
  normalizeWhatsappStorePriorityCursor,
  prioritizeWhatsappCandidates,
  WHATSAPP_STORE_PRIORITY
} from '../server/whatsappStorePriority.js';

const candidates = [
  { id: 'ali', store: 'AliExpress' },
  { id: 'magalu', offerId: 'offer-magalu' },
  { id: 'ml', offerSnapshot: { store: 'Mercado Livre' } },
  { id: 'shopee', couponSnapshot: { store: 'Shopee' } },
  { id: 'other', store: 'Outra loja' }
];
const offers = [{ id: 'offer-magalu', store: 'Magalu' }];

assert.deepEqual(
  prioritizeWhatsappCandidates(candidates, offers, 0).map((item) => item.id),
  ['ml', 'shopee', 'ali', 'magalu', 'other']
);
assert.deepEqual(
  prioritizeWhatsappCandidates(candidates.filter((item) => item.id !== 'shopee'), offers, 1).map((item) => item.id),
  ['ali', 'magalu', 'ml', 'other'],
  'quando a loja da vez não tiver oferta, deve avançar para a próxima'
);
assert.equal(nextWhatsappStorePriorityCursor(candidates[2], offers, 0), 1);
assert.equal(nextWhatsappStorePriorityCursor(candidates[0], offers, 0), 3);
assert.equal(nextWhatsappStorePriorityCursor(candidates[4], offers, 2), 2, 'lojas desconhecidas não devem alterar a rotação');
assert.equal(normalizeWhatsappStorePriorityCursor(5), 1);
assert.deepEqual(WHATSAPP_STORE_PRIORITY, ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu']);

console.log('WhatsApp: prioridade rotativa das lojas validada.');
