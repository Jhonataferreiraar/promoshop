import assert from 'node:assert/strict';

import {
  OFFER_RETENTION_DAYS,
  pruneExpiredOffers,
  restoreRecentOffersFromQueue
} from '../server/store.js';

const now = Date.parse('2026-09-03T12:00:00.000Z');
const ago = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

const data = {
  offers: [
    { id: 'fresh', title: 'Oferta recente', createdAt: ago(6) },
    { id: 'expired', title: 'Oferta expirada', createdAt: ago(7) },
    { id: 'legacy-expired', title: 'Oferta antiga sem createdAt', updatedAt: ago(8) }
  ],
  queue: [
    { id: 'queue-expired', offerId: 'expired', status: 'pending' },
    { id: 'queue-sent', offerId: 'legacy-expired', status: 'sent' }
  ]
};

const result = pruneExpiredOffers(data, now, OFFER_RETENTION_DAYS);
assert.equal(result.removedCount, 2, 'Ofertas no limite ou além de sete dias devem sair');
assert.equal(result.removedQueueItems, 1, 'A fila pendente da oferta expirada também deve ser removida');
assert.deepEqual(data.offers.map((offer) => offer.id), ['fresh']);
assert.deepEqual(data.queue.map((item) => item.id), ['queue-sent']);

const recoveryData = {
  offers: [],
  queue: [{
    id: 'queue-ml',
    offerId: 'ml_MLB123',
    offerTitle: 'Oferta Mercado Livre',
    store: 'Mercado Livre',
    status: 'pending',
    createdAt: ago(1),
    offerSnapshot: {
      id: 'ml_MLB123',
      title: 'Oferta Mercado Livre',
      store: 'Mercado Livre',
      category: 'Eletrônicos',
      price: 79.9,
      originalPrice: 129.9,
      affiliateUrl: 'https://meli.la/oferta123',
      image: 'https://http2.mlstatic.com/oferta.webp',
      targetAudienceCodes: ['G01']
    }
  }]
};

const recovery = restoreRecentOffersFromQueue(recoveryData, now, OFFER_RETENTION_DAYS);
assert.equal(recovery.restoredCount, 1, 'Uma oferta recente ausente deve ser recuperada do snapshot da fila');
assert.equal(recoveryData.offers[0].status, 'active');
assert.equal(recoveryData.offers[0].source, 'mercado-livre-extension');
assert.equal(recoveryData.offers[0].affiliateUrl, 'https://meli.la/oferta123');

console.log('Retenção: ofertas expiram em sete dias e capturas recentes da fila são preservadas.');
