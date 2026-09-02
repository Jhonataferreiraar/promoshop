import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';

const [, , ...inputArgs] = process.argv;
const names = ['mercado-livre', 'shopee', 'aliexpress', 'magalu'];
if (inputArgs.length !== names.length) {
  console.error(`Uso: node scripts/prepare-marketplace-assets.mjs ${names.map((name) => `<${name}.png>`).join(' ')}`);
  process.exit(1);
}

const outputDir = path.resolve('server', 'assets', 'marketplaces');
await fs.mkdir(outputDir, { recursive: true });

function isLightNeutral(r, g, b) {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return Math.min(r, g, b) >= 205 && spread <= 28;
}

function isDarkNeutral(r, g, b) {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return Math.max(r, g, b) <= 58 && spread <= 24;
}

function removeEdgeBackground(data, info, predicate) {
  const { width, height, channels } = info;
  const visited = new Uint8Array(width * height);
  const queue = [];

  function enqueue(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * width + x;
    if (visited[offset]) return;
    const pixel = offset * channels;
    if (data[pixel + 3] < 16 || !predicate(data[pixel], data[pixel + 1], data[pixel + 2])) return;
    visited[offset] = 1;
    queue.push(offset);
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const offset = queue[index];
    const x = offset % width;
    const y = Math.floor(offset / width);
    data[offset * channels + 3] = 0;
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
}

for (const [index, name] of names.entries()) {
  const inputPath = path.resolve(inputArgs[index]);
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const predicate = name === 'mercado-livre' || name === 'shopee'
    ? isLightNeutral
    : (r, g, b) => isLightNeutral(r, g, b) || isDarkNeutral(r, g, b);
  removeEdgeBackground(data, info, predicate);
  await sharp(data, { raw: info })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
    .resize(900, 600, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(path.join(outputDir, `${name}.png`));
  console.log(`Preparada: ${name}.png`);
}
