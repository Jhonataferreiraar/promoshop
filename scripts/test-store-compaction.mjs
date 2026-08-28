import assert from 'node:assert/strict';

import { compactStoreHistory } from '../server/store.js';
import { hasSentSourceInLedger } from '../server/whatsappDedup.js';

const sentAt = (index) => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
const data = {
  queue: Array.from({ length: 650 }, (_, index) => ({
    id: `queue-${index}`,
    offerId: `offer-${index}`,
    offerTitle: `Oferta ${index}`,
    store: 'Loja',
    status: 'sent',
    sentAt: sentAt(index),
    createdAt: sentAt(index),
    message: 'x'.repeat(5000),
    image: `https://example.com/${index}.jpg`,
    offerSnapshot: {
      id: `offer-${index}`,
      title: `Oferta ${index}`,
      store: 'Loja',
      affiliateUrl: `https://example.com/produto/${index}`,
      description: 'y'.repeat(5000)
    }
  })),
  instagramQueue: Array.from({ length: 150 }, (_, index) => ({
    id: `story-${index}`,
    sourceId: `offer-${index}`,
    kind: 'offer',
    title: `Story ${index}`,
    status: 'sent',
    createdAt: sentAt(index),
    publishedAt: sentAt(index),
    image: `https://example.com/${index}.jpg`,
    payload: 'z'.repeat(5000)
  })),
  instagramFeedQueue: [],
  logs: []
};

const originalSize = JSON.stringify(data).length;
compactStoreHistory(data);

assert.equal(data.queue.length, 500, 'A fila deve manter somente as 500 publicações enviadas mais recentes.');
assert.equal(data.meta.whatsappSentHistoryCount, 150, 'O painel deve preservar o total histórico mesmo após a limpeza.');
assert.equal(data.queue[0].id, 'queue-150', 'As publicações antigas devem sair da fila operacional.');
assert.equal(data.queue[499].historyCompacted, undefined, 'As 500 publicações mais recentes devem continuar completas.');
assert.equal(
  hasSentSourceInLedger(data, { offerId: 'offer-0', offerTitle: 'Oferta 0', store: 'Loja' }),
  true,
  'A limpeza não pode permitir que uma oferta enviada seja repetida.'
);
assert.equal(data.instagramQueue[0].historyCompacted, true, 'Stories antigos devem ser compactados.');
assert.equal(data.instagramQueue[0].payload, undefined, 'O conteúdo pesado de Stories antigos deve ser removido.');
assert.equal(data.instagramQueue[149].historyCompacted, undefined, 'Os 100 Stories mais recentes devem continuar completos.');
assert.ok(JSON.stringify(data).length < originalSize * 0.97, 'O histórico antigo deve reduzir o tamanho persistido.');

const firstPass = JSON.stringify(data);
compactStoreHistory(data);
assert.equal(JSON.stringify(data), firstPass, 'A compactação deve ser idempotente.');

console.log('Persistência: histórico compacto preserva a deduplicação e os itens recentes.');
