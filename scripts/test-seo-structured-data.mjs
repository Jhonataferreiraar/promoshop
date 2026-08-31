import assert from 'node:assert/strict';

import { buildProductStructuredData, buildWebsiteStructuredData, latestSeoDate, normalizeGtin } from '../server/seoStructuredData.js';

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

const websiteSchema = buildWebsiteStructuredData({
  brandName: 'PromoShop',
  seoSiteName: 'PromoShop',
  seoTitle: 'PromoShop - Ofertas Diárias',
  contactEmail: 'contato@example.com',
  instagramUrl: 'https://www.instagram.com/promoshop/'
}, {
  origin: 'https://promoshop.example',
  description: 'Ofertas selecionadas.'
});
const website = websiteSchema['@graph'].find((item) => item['@type'] === 'WebSite');
const organization = websiteSchema['@graph'].find((item) => item['@type'] === 'Organization');
assert.equal(website.name, 'PromoShop');
assert.equal(website.alternateName, 'Promo Shop');
assert.equal(website.url, 'https://promoshop.example/');
assert.notEqual(website.alternateName, 'promoshop.example');
assert.equal(organization.logo.url, 'https://promoshop.example/favicon-512.png');
assert.equal(organization.logo.width, 512);
assert.deepEqual(organization.sameAs, ['https://www.instagram.com/promoshop/']);

assert.equal(latestSeoDate(['2026-08-28T12:00:00Z', '2026-08-31T01:00:00Z'], '2026-08-23'), '2026-08-31');
assert.equal(latestSeoDate([], '2026-08-23-v5'), '2026-08-23');

console.log('SEO: Product e AggregateOffer validados sem dados comerciais inventados.');
