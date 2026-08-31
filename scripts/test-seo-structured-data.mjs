import assert from 'node:assert/strict';

import { buildProductStructuredData, normalizeGtin } from '../server/seoStructuredData.js';

assert.equal(normalizeGtin('7894900011517'), '7894900011517');
assert.equal(normalizeGtin('7894900011518'), '');
assert.equal(normalizeGtin('identificador-interno'), '');

const schema = buildProductStructuredData({
  id: 'offer-1', externalId: 'MLB123', title: 'Produto de teste', category: 'Eletrônicos',
  price: 99.9, image: 'https://example.com/product.jpg', brand: 'Marca real',
  gtin: '7894900011517', rating: 4.8, ratingCount: 25
}, {
  canonical: 'https://promoshop.example/oferta/produto',
  description: 'Oferta encontrada em loja parceira.'
});

assert.equal(schema['@type'], 'Product');
assert.equal(schema.offers['@type'], 'AggregateOffer');
assert.equal(schema.offers.lowPrice, '99.90');
assert.equal(schema.offers.offerCount, 1);
assert.equal(schema.brand.name, 'Marca real');
assert.equal(schema.gtin13, '7894900011517');
assert.equal(schema.aggregateRating.ratingCount, 25);
assert.equal(schema.sku, 'MLB123');
assert.equal(schema.offers.hasMerchantReturnPolicy, undefined);
assert.equal(schema.offers.shippingDetails, undefined);

const conservativeSchema = buildProductStructuredData({ id: 'offer-2', title: 'Produto sem dados inventados', price: 20 }, { canonical: 'https://example.com/oferta' });
assert.equal(conservativeSchema.brand, undefined);
assert.equal(conservativeSchema.aggregateRating, undefined);
assert.equal(conservativeSchema.review, undefined);

console.log('SEO: Product e AggregateOffer validados sem dados comerciais inventados.');
