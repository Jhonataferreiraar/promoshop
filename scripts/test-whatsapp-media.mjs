import assert from 'node:assert/strict';

import sharp from 'sharp';

import { normalizeWhatsappImage } from '../server/whatsappMedia.js';

const source = await sharp({
  create: { width: 2400, height: 1800, channels: 4, background: { r: 18, g: 105, b: 243, alpha: 0.75 } }
}).webp().toBuffer();
const normalized = await normalizeWhatsappImage(source);
const metadata = await sharp(normalized).metadata();

assert.equal(metadata.format, 'jpeg');
assert.ok(metadata.width <= 1600);
assert.ok(metadata.height <= 1600);
assert.equal(metadata.channels, 3);
assert.ok(normalized.length > 0);

console.log('WhatsApp: conversão de imagens para JPEG validada.');
