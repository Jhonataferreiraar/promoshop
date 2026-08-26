import assert from 'node:assert/strict';
import { hasPendingSource, queueItemSourceMatches, wasRecentlySentToAudience } from '../server/whatsappDedup.js';

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
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G02', 24), true);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G03', 24), false);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G02', 1), false);
assert.equal(wasRecentlySentToAudience([sent], candidate, 'G02', 0), false);
assert.equal(hasPendingSource([{ ...candidate, status: 'pending' }], candidate), true);
assert.equal(hasPendingSource([{ ...candidate, status: 'sent' }], candidate), false);

const different = { ...candidate, offerId: 'ml_999', offerTitle: 'Outro produto' };
assert.equal(queueItemSourceMatches(candidate, different), false);
console.log('Deduplicação por oferta e grupo validada.');
