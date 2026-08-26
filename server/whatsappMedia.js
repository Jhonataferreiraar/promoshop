import path from 'node:path';

import sharp from 'sharp';

const MAXIMUM_SOURCE_BYTES = 12 * 1024 * 1024;

export async function normalizeWhatsappImage(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source || []);
  if (!buffer.length) throw new Error('A imagem recebida está vazia.');
  if (buffer.length > MAXIMUM_SOURCE_BYTES) throw new Error('A imagem excede o limite de 12 MB.');
  return sharp(buffer)
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export async function downloadWhatsappImage(imageUrl) {
  const url = new URL(String(imageUrl || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('O endereço da imagem é inválido.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; PromoShop/1.0)'
      }
    });
    if (!response.ok) throw new Error(`A loja respondeu ${response.status} ao baixar a imagem.`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
      throw new Error('O endereço não retornou uma imagem válida.');
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAXIMUM_SOURCE_BYTES) throw new Error('A imagem excede o limite de 12 MB.');
    const source = Buffer.from(await response.arrayBuffer());
    const data = await normalizeWhatsappImage(source);
    const originalName = path.basename(url.pathname).replace(/[^a-z0-9._-]+/gi, '-').replace(/\.[^.]+$/, '').slice(0, 60) || 'oferta';
    return { data, mimetype: 'image/jpeg', filename: `${originalName}.jpg`, filesize: data.length };
  } finally {
    clearTimeout(timer);
  }
}
