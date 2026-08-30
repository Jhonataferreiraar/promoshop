import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';

import { backfillInstagramFeedFromRecentWhatsapp, enqueueInstagramFeedFromWhatsapp, enqueueInstagramForCompletedWhatsappRound, enqueueInstagramFromWhatsapp, feedEntryRepeatsPublishedSource, formatInstagramRetryAt, generateInstagramFeedAsset, generateInstagramHighlightAsset, generateInstagramStory, instagramRateLimitUntil, instagramWaitsForWhatsappRound, isInstagramRateLimitError, sanitizeFeedCaption, verifyInstagramSignedRequest } from '../server/instagram.js';
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
const signingKey = crypto.randomBytes(32).toString('hex');
const signedSignature = crypto.createHmac('sha256', signingKey).update(signedPayload).digest('base64url');
assert.equal(verifyInstagramSignedRequest(`${signedSignature}.${signedPayload}`, signingKey).user_id, '123');
assert.throws(() => verifyInstagramSignedRequest(`invalid.${signedPayload}`, signingKey));
assert.equal(isInstagramRateLimitError({ metaCode: 429, message: 'Too many requests' }), true);
const futureRetry = new Date(Date.now() + 60_000).toISOString();
assert.equal(instagramRateLimitUntil({
  instagramQueue: [{ status: 'sent', instagramRateLimited: true, retryAt: new Date(Date.now() + 120_000).toISOString() }],
  instagramFeedQueue: [{ status: 'pending', instagramRateLimited: true, retryAt: futureRetry }]
}), new Date(futureRetry).getTime(), 'a pausa deve considerar apenas publicações pendentes');
assert.equal(formatInstagramRetryAt(null), '', 'uma pausa sem data não pode virar dezembro de 1969');
assert.equal(formatInstagramRetryAt('1970-01-01T00:00:00.000Z'), '', 'uma pausa vencida não deve ser exibida');
assert.match(formatInstagramRetryAt(futureRetry), /\d{2}\/\d{2}\/\d{4}/, 'uma pausa futura válida deve ser exibida');
assert.equal(instagramWaitsForWhatsappRound({ meta: { publicationRound: { id: 'round-1', pendingAudienceCodes: ['G02'] } } }), true, 'o Instagram deve aguardar a rodada ativa do WhatsApp');
assert.equal(instagramWaitsForWhatsappRound({ meta: { publicationRound: null } }), false, 'o Instagram deve ser liberado depois da rodada');

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

const backfillData = {
  config: { ...feedData.config, instagramFeedCarouselSize: 2, instagramFeedMinimumDiscount: 20 },
  offers: [
    data.offers[0],
    { id: 'offer-2', title: 'Fone Bluetooth em promoção', store: 'Magalu', price: 79.9, originalPrice: 119.9, discount: 33, image: 'https://example.com/headphone.jpg', affiliateUrl: 'https://example.com/headphone' }
  ],
  queue: [
    { id: 'whatsapp-1', offerId: 'offer-1', status: 'sent', sentAt: new Date().toISOString(), targetAudienceCodes: ['G01'] },
    { id: 'whatsapp-2', offerId: 'offer-2', status: 'sent', sentAt: new Date().toISOString(), targetAudienceCodes: ['G01'] }
  ],
  instagramFeedQueue: []
};
assert.equal(backfillInstagramFeedFromRecentWhatsapp(backfillData), 2, 'deve recuperar ofertas já enviadas ao WhatsApp');
assert.equal(backfillData.instagramFeedQueue[0].items.length, 2, 'deve montar o carrossel com as ofertas recentes');
assert.equal(backfillInstagramFeedFromRecentWhatsapp(backfillData), 0, 'não deve duplicar o preenchimento automático');

const completedRoundData = {
  config: {
    ...feedData.config,
    instagramAudienceCodes: [],
    instagramFeedCarouselSize: 2
  },
  meta: { publicationRound: { id: 'round-active', pendingAudienceCodes: ['G02'] } },
  offers: [
    data.offers[0],
    { id: 'offer-round-2', title: 'Fone Bluetooth da rodada', store: 'Magalu', price: 89.9, originalPrice: 129.9, discount: 30, image: 'https://example.com/round-headphone.jpg', affiliateUrl: 'https://example.com/round-headphone' }
  ],
  queue: [
    { id: 'round-queue-1', roundId: 'round-active', offerId: 'offer-1', status: 'sent', sentAt: '2026-08-30T12:00:00.000Z', targetAudienceCodes: ['G01'] },
    { id: 'round-queue-2', roundId: 'round-active', offerId: 'offer-round-2', status: 'sent', sentAt: '2026-08-30T12:01:00.000Z', targetAudienceCodes: ['G02'] }
  ],
  instagramQueue: [],
  instagramFeedQueue: []
};
assert.equal(backfillInstagramFeedFromRecentWhatsapp(completedRoundData), 0, 'o Feed não pode antecipar uma rodada ainda ativa');
const releasedRound = enqueueInstagramForCompletedWhatsappRound(completedRoundData, 'round-active');
assert.equal(releasedRound.processed, 2, 'todas as ofertas enviadas na rodada devem ser processadas juntas');
assert.equal(releasedRound.stories.length, 2, 'os Stories devem ser liberados somente ao concluir a rodada');
assert.equal(releasedRound.feed.length, 1, 'as ofertas devem compor um único carrossel da rodada');
assert.equal(completedRoundData.instagramFeedQueue[0].items.length, 2);
assert.ok(completedRoundData.queue.every((item) => item.instagramReleaseProcessedAt));
assert.equal(enqueueInstagramForCompletedWhatsappRound(completedRoundData, 'round-active').processed, 0, 'a liberação da rodada deve ser idempotente');

const permanentFailureData = {
  config: { ...feedData.config, instagramFeedCarouselSize: 2 },
  offers: backfillData.offers,
  queue: backfillData.queue,
  instagramFeedQueue: [{
    id: 'feed-failed', origin: 'whatsapp', postType: 'carousel', status: 'failed',
    sourceIds: ['offer-1', 'offer-2'], items: [], createdAt: new Date().toISOString(),
    permanentFailure: true, error: 'A Meta não reconheceu a mídia.'
  }]
};
assert.equal(backfillInstagramFeedFromRecentWhatsapp(permanentFailureData), 0, 'uma falha permanente não pode recriar o mesmo carrossel');
assert.equal(permanentFailureData.instagramFeedQueue.length, 1, 'a fila deve permanecer estável após a falha permanente');

const publishedFeed = { id: 'feed-sent', status: 'sent', sourceIds: ['offer-1', 'offer-2'], publishedAt: new Date().toISOString() };
assert.equal(feedEntryRepeatsPublishedSource([publishedFeed], { id: 'feed-next', sourceIds: ['offer-2', 'offer-3'] }, 7), true, 'qualquer oferta já publicada deve bloquear o carrossel repetido');
assert.equal(feedEntryRepeatsPublishedSource([publishedFeed], { id: 'feed-new', sourceIds: ['offer-4'] }, 7), false, 'um carrossel com ofertas novas deve continuar permitido');

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

const feedFixtureImage = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
await assert.rejects(
  generateInstagramFeedAsset({ title: 'Oferta sem imagem', store: 'Magalu', price: 99.9, image: '' }, config),
  (error) => error?.code === 'INSTAGRAM_IMAGE_UNAVAILABLE',
  'o Feed deve bloquear uma oferta sem imagem válida'
);

const feedAsset = await generateInstagramFeedAsset({ title: 'Notebook PromoShop', store: 'Magalu', price: 1999.9, originalPrice: 2499.9, discount: 20, image: '', link: 'https://example.com/offer' }, { ...config, instagramFeedTemplateMode: 'editorial' }, 'independence', 'portrait', feedFixtureImage);
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
  const variant = await generateInstagramFeedAsset({ title: 'Oferta PromoShop para validar o layout', store: 'Shopee', price: 129.9, originalPrice: 199.9, discount: 35, image: '', link: 'https://example.com/offer' }, { ...config, instagramFeedTemplateMode: templateMode }, 'default', 'portrait', feedFixtureImage);
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
