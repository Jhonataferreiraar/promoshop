import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const source = await readFile(path.join(publicDir, 'favicon-original.png'));
const sourceDataUrl = `data:image/png;base64,${source.toString('base64')}`;
const outputs = [
  ['favicon-48.png', 48],
  ['apple-touch-icon.png', 180],
  ['favicon-192.png', 192],
  ['favicon-512.png', 512]
];

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const [filename, size] of outputs) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}img{display:block;width:100%;height:100%;object-fit:contain;transform:scale(1.48)}</style><img src="${sourceDataUrl}" alt="">`, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(publicDir, filename), omitBackground: true });
  }
} finally {
  await browser.close();
}

console.log('Favicons PNG gerados a partir do ícone original.');
