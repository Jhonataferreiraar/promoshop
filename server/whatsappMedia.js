import path from 'node:path';

import sharp from 'sharp';
import { downloadRemoteBuffer } from './safeRemote.js';

const MAXIMUM_SOURCE_BYTES = 12 * 1024 * 1024;
const MAXIMUM_INPUT_PIXELS = 25_000_000;

// O publicador roda no mesmo serviço que a API. Limitar o cache e a
// concorrência do libvips evita que uma conversão isolada reserve centenas de
// megabytes enquanto o Chromium do WhatsApp já está ativo.
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 16, items: 64 });

export async function normalizeWhatsappImage(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source || []);
  if (!buffer.length) throw new Error('A imagem recebida está vazia.');
  if (buffer.length > MAXIMUM_SOURCE_BYTES) throw new Error('A imagem excede o limite de 12 MB.');
  return sharp(buffer, { limitInputPixels: MAXIMUM_INPUT_PIXELS })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export async function downloadWhatsappImage(imageUrl) {
  const result = await downloadRemoteBuffer(imageUrl, {
    maximumBytes: MAXIMUM_SOURCE_BYTES,
    timeoutMs: 20_000,
    acceptedContentTypes: ['image/', 'application/octet-stream'],
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; PromoShop/1.0)'
    }
  });
  const data = await normalizeWhatsappImage(result.buffer);
  const originalName = path.basename(result.finalUrl.pathname).replace(/[^a-z0-9._-]+/gi, '-').replace(/\.[^.]+$/, '').slice(0, 60) || 'oferta';
  return { data, mimetype: 'image/jpeg', filename: `${originalName}.jpg`, filesize: data.length };
}
