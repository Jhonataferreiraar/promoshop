import assert from 'node:assert/strict';
import { hasBlockingPendingSource, hasOtherPendingSource, hasPendingSource, hasSentSource, queueItemSourceMatches, wasRecentlySentToAudience } from '../server/whatsappDedup.js';

const candidate = {
  kind: 'offer',
  offerId: 'ml_123',
  offerTitle: 'Fone Bluetooth com Cancelamento',
  store: 'Mercado Livre',
  targetAudienceCodes: ['G02']
};

const sent = {
  ...candidate,
  status: 'sent',
  sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  roundAudienceCode: 'G02'
};

assert.equal(queueItemSourceMatches(candidate, sent), true);
assert.equal(queueItemSourceMatches({ id: 'ml_123', title: candidate.offerTitle, store: candidate.store }, candidate), true);
assert.equal(queueItemSourceMatches({ ...candidate, affiliateUrl: 'https://loja.example/item?utm_source=old' }, { ...candidate, affiliateUrl: 'https://loja.example/item?utm_source=new' }), true);
assert.equal(queueItemSourceMatches({ kind: 'offer', externalId: '123', source: 'mercado-livre', title: 'Produto', store: 'Mercado Livre' }, { kind: 'offer', externalId: '123', source: 'mercado-livre', title: 'Título atualizado', store: 'Mercado Livre' }), true);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G02', 24), true);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G03', 24), false);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G02', 1), false);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G02', 0), false);
assert.equal(hasSentSource([sent], candidate), true);
assert.equal(hasPendingSource([{ ...candidate, status: 'pending' }], candidate), true);
assert.equal(hasPendingSource([{ ...candidate, status: 'sent' }], candidate), false);
assert.equal(hasOtherPendingSource([{ ...candidate, status: 'pending' }], candidate), false);
assert.equal(hasOtherPendingSource([{ ...candidate, id: 'queue_other', status: 'publishing' }], candidate), true);
assert.equal(hasBlockingPendingSource([{ ...candidate, id: 'queue_other', createdAt: '2026-08-26T10:00:00.000Z', status: 'pending' }, { ...candidate, id: 'queue_current', createdAt: '2026-08-26T11:00:00.000Z', status: 'pending' }], { ...candidate, id: 'queue_current', createdAt: '2026-08-26T11:00:00.000Z' }), true);
assert.equal(hasBlockingPendingSource([{ ...candidate, id: 'queue_other', createdAt: '2026-08-26T10:00:00.000Z', status: 'pending' }, { ...candidate, id: 'queue_current', createdAt: '2026-08-26T11:00:00.000Z', status: 'pending' }], { ...candidate, id: 'queue_other', createdAt: '2026-08-26T10:00:00.000Z' }), false);

const different = { ...candidate, offerId: 'ml_999', offerTitle: 'Outro produto' };
assert.equal(queueItemSourceMatches(candidate, different), false);
console.log('Deduplicação por oferta e grupo validada.');
