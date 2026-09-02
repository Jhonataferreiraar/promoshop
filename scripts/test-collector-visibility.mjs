import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promoshop-collector-'));
process.env.DATA_DIR = dataDir;
process.env.STORE_BACKEND = 'file';

const { readStore, updateStore } = await import('../server/store.js');
const { applyCollectedOffers, makeQueueItem } = await import('../server/collectors.js');

const product = {
  id: 'ml_MLB123456789',
  externalId: 'MLB123456789',
  title: 'Monitor portátil em promoção',
  store: 'Mercado Livre',
  category: 'Eletrônicos',
  price: 399.9,
  originalPrice: 599.9,
  image: 'https://http2.mlstatic.com/D_NQ_NP_123-O.webp',
  productUrl: 'https://www.mercadolivre.com.br/MLB-123456789-monitor-portatil',
  affiliateUrl: 'https://www.mercadolivre.com.br/MLB-123456789-monitor-portatil',
  status: 'pending-link',
  source: 'mercado-livre',
  score: 33,
  createdAt: new Date().toISOString()
};

try {
  await updateStore((data) => {
    data.config.autoQueue = true;
    data.offers = [structuredClone(product)];
    data.queue = [];
  });

  const firstResult = await applyCollectedOffers({
    candidates: [{
      ...product,
      affiliateUrl: 'https://meli.la/monitor123',
      status: 'active'
    }]
  });

  let saved = await readStore();
  assert.equal(firstResult.activated, 1);
  assert.equal(saved.offers[0].status, 'active');
  assert.equal(saved.offers[0].affiliateUrl, 'https://meli.la/monitor123');
  assert.equal(saved.queue.length, 1, 'Uma oferta ativada deve entrar na fila automática uma única vez.');
  assert.equal(saved.queue[0].offerSnapshot.affiliateUrl, 'https://meli.la/monitor123');

  await updateStore((data) => {
    data.config.autoQueue = false;
    data.offers = [structuredClone(product)];
    data.queue = [{ ...makeQueueItem(product, data.config), status: 'pending' }];
  });

  await applyCollectedOffers({
    candidates: [{
      ...product,
      affiliateUrl: 'https://meli.la/monitor456',
      status: 'active'
    }]
  });

  saved = await readStore();
  assert.equal(saved.queue[0].offerSnapshot.affiliateUrl, 'https://meli.la/monitor456');
  assert.equal(saved.queue[0].offerId, product.id);

  const extensionOffer = {
    ...product,
    id: 'ml_MLB987654321',
    externalId: 'MLB987654321',
    source: 'mercado-livre-extension',
    status: 'active',
    affiliateUrl: 'https://meli.la/oficial987'
  };
  await updateStore((data) => {
    data.offers = [structuredClone(extensionOffer)];
    data.queue = [];
  });

  await applyCollectedOffers({
    candidates: [{
      ...extensionOffer,
      source: 'mercado-livre',
      status: 'pending-link',
      affiliateUrl: extensionOffer.productUrl
    }]
  });

  saved = await readStore();
  assert.equal(saved.offers[0].status, 'active');
  assert.equal(saved.offers[0].affiliateUrl, 'https://meli.la/oficial987', 'Uma coleta sem link não pode apagar o vínculo da extensão oficial.');

  const oldPending = {
    ...product,
    id: 'ml_MLB000000001',
    externalId: 'MLB000000001',
    title: 'Oferta antiga aguardando vínculo',
    productUrl: 'https://www.mercadolivre.com.br/MLB-000000001-oferta-antiga',
    affiliateUrl: 'https://www.mercadolivre.com.br/MLB-000000001-oferta-antiga',
    status: 'pending-link'
  };
  const recentOffers = Array.from({ length: 500 }, (_, index) => ({
    ...product,
    id: `ml_recent_${index}`,
    externalId: `MLB_RECENT_${index}`,
    title: `Oferta recente ${index}`,
    status: 'active',
    affiliateUrl: `https://meli.la/recent${index}`
  }));
  await updateStore((data) => {
    data.offers = [...recentOffers, oldPending];
    data.queue = [];
    data.config.autoQueue = false;
  });

  await applyCollectedOffers({
    candidates: [{
      ...oldPending,
      affiliateUrl: 'https://meli.la/antiga001',
      status: 'active'
    }]
  });

  saved = await readStore();
  assert.equal(saved.offers.length, 500, 'O catálogo continua limitado às 500 ofertas.');
  assert.equal(saved.offers[0].id, oldPending.id, 'Uma oferta antiga ativada deve ser promovida antes da compactação.');
  assert.equal(saved.offers[0].affiliateUrl, 'https://meli.la/antiga001');

  console.log('Coleta: ofertas do Mercado Livre entram na vitrine após o link e preservam vínculos oficiais.');
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
