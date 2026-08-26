import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';

import { enqueueInstagramFeedFromWhatsapp, enqueueInstagramFromWhatsapp, generateInstagramFeedAsset, generateInstagramHighlightAsset, generateInstagramStory, sanitizeFeedCaption, verifyInstagramSignedRequest } from '../server/instagram.js';
import { DEFAULT_INSTAGRAM_THEMES, sanitizeInstagramThemes, selectInstagramTheme } from '../server/instagramThemes.js';
import { sanitizeInstagramHighlights } from '../server/instagramHighlights.js';

const config = {
  canonicalUrl: 'https://promoshop.jhonatafaraujo.com.br',
  instagramEnabled: true,
  instagramAutoFromWhatsapp: true,
  instagramIncludeCoupons: true,
  instagramMinimumDiscount: 20,
  instagramDuplicateDays: 7,
  instagramStores: ['Magalu'],
  instagramAudienceCodes: ['G01'],
  instagramThemeMode: 'automatic',
  instagramThemes: DEFAULT_INSTAGRAM_THEMES,
  instagramCtaText: 'Acesse o link da bio',
  instagramDisclosureText: 'Publicidade · link de afiliado',
  instagramShowQrCode: false
};

assert.equal(selectInstagramTheme(config, new Date('2026-12-20T12:00:00-03:00')).id, 'christmas');
assert.equal(selectInstagramTheme(config, new Date('2026-11-25T12:00:00-03:00')).id, 'black-friday');
assert.equal(selectInstagramTheme(config, new Date('2026-01-02T12:00:00-03:00')).id, 'new-year');
assert.equal(selectInstagramTheme(config, new Date('2026-09-07T12:00:00-03:00')).id, 'independence');
assert.ok(sanitizeInstagramThemes([{ id: 'default', name: 'PromoShop' }]).some((theme) => theme.id === 'independence'), 'temas sazonais novos devem aparecer em configurações antigas');
assert.equal(sanitizeInstagramThemes([{ id: 'x', name: 'X', background: 'invalid' }])[0].background, '#1269f3');
assert.equal(sanitizeInstagramHighlights([{ id: 'offers', name: 'Ofertas', icon: 'invalid', description: 'Teste' }])[0].icon, 'star');

const signedPayload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '123' })).toString('base64url');
const signedSecret = 'app-secret-for-test';
const signedSignature = crypto.createHmac('sha256', signedSecret).update(signedPayload).digest('base64url');
assert.equal(verifyInstagramSignedRequest(`${signedSignature}.${signedPayload}`, signedSecret).user_id, '123');
assert.throws(() => verifyInstagramSignedRequest(`invalid.${signedPayload}`, signedSecret));

const data = {
  config,
  offers: [{ id: 'offer-1', title: 'Smartphone com câmera de alta resolução', store: 'Magalu', price: 999.9, originalPrice: 1299.9, discount: 23, image: 'https://example.com/product.jpg', affiliateUrl: 'https://example.com/offer' }],
  instagramQueue: []
};
const queued = enqueueInstagramFromWhatsapp(data, { id: 'queue-1', offerId: 'offer-1', targetAudienceCodes: ['G01'] });
assert.ok(queued);
assert.equal(data.instagramQueue.length, 1);
assert.equal(enqueueInstagramFromWhatsapp(data, { id: 'queue-2', offerId: 'offer-1', targetAudienceCodes: ['G01'] }), null, 'não deve duplicar a oferta');

const feedData = {
  config: { ...config, instagramFeedEnabled: true, instagramFeedAutoFromWhatsapp: true, instagramFeedPostType: 'carousel', instagramFeedCarouselSize: 2, instagramFeedMinimumDiscount: 0, instagramFeedCaption: 'Confira:\n{offers}\nAcesse a bio do perfil' },
  offers: data.offers,
  coupons: [],
  instagramFeedQueue: []
};
assert.ok(enqueueInstagramFeedFromWhatsapp(feedData, { id: 'feed-1', offerId: 'offer-1', targetAudienceCodes: ['G01'] }));
assert.equal(feedData.instagramFeedQueue[0].postType, 'carousel');

const asset = await generateInstagramStory({ title: 'Smartphone com câmera de alta resolução', store: 'Magalu', price: 999.9, originalPrice: 1299.9, discount: 23, image: '', link: 'https://example.com/offer' }, config, 'christmas');
try {
  const metadata = await sharp(asset.filePath).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1920);
  assert.equal(asset.themeId, 'christmas');
} finally {
  await fs.unlink(asset.filePath).catch(() => {});
}

const feedAsset = await generateInstagramFeedAsset({ title: 'Notebook PromoShop', store: 'Magalu', price: 1999.9, originalPrice: 2499.9, discount: 20, image: '', link: 'https://example.com/offer' }, { ...config, instagramFeedTemplateMode: 'editorial' }, 'independence', 'portrait');
try {
  const metadata = await sharp(feedAsset.filePath).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1350);
  assert.equal(feedAsset.themeId, 'independence');
  assert.equal(feedAsset.template, 'editorial');
} finally {
  await fs.unlink(feedAsset.filePath).catch(() => {});
}

for (const variant of ['cover', 'story']) {
  const highlightAsset = await generateInstagramHighlightAsset({ name: 'Ofertas', icon: 'bolt', description: 'Achados e promoções selecionadas todos os dias.' }, config, 'default', variant);
  try {
    const metadata = await sharp(highlightAsset.filePath).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1920);
    assert.equal(highlightAsset.variant, variant);
  } finally {
    await fs.unlink(highlightAsset.filePath).catch(() => {});
  }
}

for (const templateMode of ['classic', 'spotlight', 'split', 'showcase', 'minimal', 'flash']) {
  const variant = await generateInstagramFeedAsset({ title: 'Oferta PromoShop para validar o layout', store: 'Shopee', price: 129.9, originalPrice: 199.9, discount: 35, image: '', link: 'https://example.com/offer' }, { ...config, instagramFeedTemplateMode: templateMode }, 'default', 'portrait');
  try {
    const metadata = await sharp(variant.filePath).metadata();
    assert.equal(variant.template, templateMode);
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1350);
  } finally {
    await fs.unlink(variant.filePath).catch(() => {});
  }
}

const localCaption = sanitizeFeedCaption('', [{ sourceId: 'offer-1', title: 'Notebook extremamente longo que não deve aparecer na descrição', store: 'Magalu', discount: 20 }]);
assert.match(localCaption, /Acesse a bio do perfil/);
assert.doesNotMatch(localCaption, /Notebook extremamente longo/);
assert.doesNotMatch(sanitizeFeedCaption('{offers}', [{ sourceId: 'offer-2', title: 'Produto que deve ficar fora da legenda', store: 'Shopee', discount: 15 }]), /Produto que deve ficar fora da legenda/);
assert.doesNotMatch(sanitizeFeedCaption('🔥 Ofertas selecionadas do dia\n\n• Produto antigo que não deve continuar na legenda', [{ sourceId: 'offer-3', title: 'Produto novo', store: 'AliExpress', discount: 10 }]), /Produto antigo/);

console.log('Instagram: temas, filtros, duplicidade e imagem 1080x1920 validados.');
