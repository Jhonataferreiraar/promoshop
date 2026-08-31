import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { buildWebsiteStructuredData, latestSeoDate } from '../server/seoStructuredData.js';

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

const serverSource = await fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8');
assert.match(serverSource, /seo\.isOfferRoute \? 'noindex, follow'/);
assert.doesNotMatch(serverSource, /buildProductStructuredData/);
assert.doesNotMatch(serverSource, /entries\.set\(`\/oferta\//);

console.log('SEO: identidade do site e datas de rastreamento validadas sem marcação comercial.');
