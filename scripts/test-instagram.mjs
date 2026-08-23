import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';

import { enqueueInstagramFromWhatsapp, generateInstagramStory, verifyInstagramSignedRequest } from '../server/instagram.js';
import { DEFAULT_INSTAGRAM_THEMES, sanitizeInstagramThemes, selectInstagramTheme } from '../server/instagramThemes.js';

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
assert.equal(sanitizeInstagramThemes([{ id: 'x', name: 'X', background: 'invalid' }])[0].background, '#1269f3');

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

console.log('Instagram: temas, filtros, duplicidade e imagem 1080x1920 validados.');
