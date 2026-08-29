import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';
import sharp from 'sharp';
import { downloadRemoteBuffer } from './safeRemote.js';
import { readTextLimited } from './httpBody.js';

import { addBufferedLog, createId, readStore, updateStore } from './store.js';
import { readSecrets, updateSecrets } from './secrets.js';
import { selectInstagramTheme } from './instagramThemes.js';

// O servidor também atende o site e mantém o WhatsApp no mesmo serviço.
// Uma única tarefa nativa do Sharp evita que a geração de carrosséis ocupe
// todos os CPUs do Render e deixe as rotas HTTP sem tempo de processamento.
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 16, items: 64 });

function highlightIconSvg(icon, color = '#1269f3') {
  const common = `fill="none" stroke="${escapeXml(color)}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"`;
  const icons = {
    bolt: `<path d="M132 18 55 126h61l-18 96 87-122h-62z" fill="${escapeXml(color)}"/>`,
    ticket: `<path d="M31 69a28 28 0 0 0 0 56v47h178v-47a28 28 0 0 0 0-56V22H31z" ${common}/><path d="M91 69v56m58-56v56" ${common}/>` ,
    users: `<circle cx="88" cy="79" r="35" ${common}/><circle cx="166" cy="91" r="27" ${common}/><path d="M25 205c5-51 31-76 64-76s59 25 64 76m-9-63c38-6 64 17 70 61" ${common}/>` ,
    info: `<circle cx="120" cy="120" r="92" ${common}/><path d="M120 105v65m0-101v2" ${common}/>` ,
    store: `<path d="M33 91h174l-17-58H50zM45 91v116h150V91M88 207v-68h64v68" ${common}/><path d="M33 91c0 25 36 25 36 0 0 25 36 25 36 0 0 25 36 25 36 0 0 25 36 25 36 0 0 25 30 25 30 0" ${common}/>` ,
    message: `<path d="M28 42h184v128H95l-55 43 14-43H28z" ${common}/><path d="M72 102h96" ${common}/>` ,
    heart: `<path d="M120 207C20 145 21 62 72 43c28-10 48 5 48 5s20-15 48-5c51 19 52 102-48 164z" fill="${escapeXml(color)}"/>`,
    star: `<path d="m120 21 29 60 66 9-48 46 12 66-59-31-59 31 12-66-48-46 66-9z" fill="${escapeXml(color)}"/>`
  };
  return icons[icon] || icons.star;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const mediaDir = path.join(dataDir, 'instagram-stories');
const MEDIA_FILE = /^[a-z0-9][a-z0-9._-]{5,100}\.jpe?g$/i;
const DAY = 24 * 60 * 60 * 1000;
const META_REQUEST_TIMEOUT_MS = 90_000;
const STALE_PUBLICATION_MS = 15 * 60_000;
let processing = false;
let metaPublishing = false;

function cleanVersion(value) {
  return /^v\d+\.\d+$/.test(String(value || '')) ? String(value) : 'v25.0';
}

function graphUrl(config, pathname) {
  return `https://graph.instagram.com/${cleanVersion(config.instagramApiVersion)}${pathname}`;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Normalize editable labels while keeping emoji. The production image includes
// Noto Color Emoji, so the bio can use the same emojis as the Instagram profile.
function svgText(value) {
  return String(value || '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function bioLineMarkup(line, baseline, fontFamily, fontSize = 34) {
  const match = String(line || '').match(/^(⚡|💸|🛒|👇)\s*(.*)$/u);
  if (!match) {
    return `<text x="540" y="${baseline}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" font-weight="600" fill="#475467">${escapeXml(line)}</text>`;
  }

  const [, emoji, label] = match;
  const safeLabel = String(label || '').trim();
  const textWidth = Math.max(90, Math.min(760, safeLabel.length * fontSize * 0.53));
  const iconSize = 34;
  const gap = 12;
  // O grupo é reduzido para .82; calcular a largura já reduzida evita que
  // a transformação empurre a linha alguns pixels para a esquerda.
  const scaledWidth = (iconSize + gap + textWidth) * 0.82;
  const startX = 540 - (scaledWidth / 2);
  const iconY = baseline - 29;
  const icons = {
    '⚡': `<path d="M20 0 4 19h11L10 38l24-25H22z" fill="#f59e0b"/>`,
    '💸': `<rect x="1" y="4" width="34" height="26" rx="6" fill="#10b981"/><circle cx="18" cy="17" r="7" fill="none" stroke="#fff" stroke-width="2"/><path d="M18 11v12M15 14h5M15 20h5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
    '🛒': `<path d="M2 4h5l3 18h18l4-12H9" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13" cy="31" r="3" fill="#2563eb"/><circle cx="27" cy="31" r="3" fill="#2563eb"/>`,
    '👇': `<path d="M17 1v21l-7-7-5 5 16 17 16-17-5-5-7 7V1z" fill="#ef4444"/>`
  };
  return `<g transform="translate(${startX} ${iconY}) scale(.82)">${icons[emoji]}<text x="${(iconSize + gap) / .82}" y="36" font-family="${fontFamily}" font-size="${fontSize}" font-weight="600" fill="#475467">${escapeXml(safeLabel)}</text></g>`;
}

function splitLines(value, maxCharacters = 31, maxLines = 4) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  const original = words.join(' ');
  const shown = lines.join(' ');
  if (shown.length < original.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?-]*$/, '').slice(0, Math.max(8, maxCharacters - 2))}…`;
  }
  return lines;
}

function splitParagraphLines(value, maxCharacters = 31, maxLines = 4) {
  const lines = [];
  for (const paragraph of String(value || '').split(/\r?\n/)) {
    if (lines.length >= maxLines) break;
    const remaining = maxLines - lines.length;
    lines.push(...splitLines(paragraph, maxCharacters, remaining).slice(0, remaining));
  }
  return lines.slice(0, maxLines);
}

function money(value) {
  const amount = Number(value || 0);
  return amount > 0
    ? amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '';
}

function validHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function isInstagramRateLimitError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const code = Number(error?.metaCode || error?.code || 0);
  return [4, 17, 32, 429, 613].includes(code) || /user is performing too many actions|too many actions|too many requests|rate[ _-]?limit|limitou temporariamente|excesso de ações|(#4|#17|#32|#613)/i.test(message);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientMetaError(error) {
  const status = Number(error?.httpStatus || error?.status || error?.metaCode || 0);
  return error?.name === 'AbortError' || error instanceof TypeError || status >= 500;
}

export function instagramRateLimitUntil(data = {}) {
  return Math.max(
    0,
    ...[...(data.instagramQueue || []), ...(data.instagramFeedQueue || [])]
      .filter((item) => ['pending', 'publishing'].includes(item.status) && (item.instagramRateLimited === true || isInstagramRateLimitError({ message: item.error })))
      .map((item) => new Date(item.retryAt || 0).getTime())
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > Date.now())
  );
}

export function formatInstagramRetryAt(value, now = Date.now()) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp <= now) return '';
  return new Date(timestamp).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo'
  });
}

function appendActivity(data, message, level = 'info') {
  data.logs ||= [];
  data.logs.unshift({ id: createId('log'), message, level, createdAt: new Date().toISOString() });
  data.logs = data.logs.slice(0, 200);
}

async function fetchBuffer(url, maximumBytes = 12 * 1024 * 1024) {
  const safeUrl = validHttps(url);
  if (!safeUrl) return null;
  const result = await downloadRemoteBuffer(safeUrl, {
    maximumBytes,
    timeoutMs: 15_000,
    acceptedContentTypes: ['image/', 'application/octet-stream'],
    headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
  });
  return result.buffer;
}

function decorationSvg(theme) {
  const accent = escapeXml(theme.accent);
  const common = `fill="${accent}" opacity=".24"`;
  const shapes = {
    confetti: `<path d="M80 260l34 16-17 34-34-16zM930 180l28 31-31 28-28-31zM950 720l24 10-10 24-24-10z" ${common}/><circle cx="125" cy="820" r="18" ${common}/>` ,
    dots: `<circle cx="90" cy="250" r="38" ${common}/><circle cx="980" cy="310" r="24" ${common}/><circle cx="930" cy="860" r="55" ${common}/>` ,
    hearts: `<path d="M100 265c-42-42-94 22 0 92 94-70 42-134 0-92zM946 720c-34-34-76 18 0 74 76-56 34-108 0-74z" ${common}/>` ,
    flags: `<path d="M0 250L1080 145" stroke="${accent}" stroke-width="8" opacity=".3"/><path d="M170 225l80-8-31 86zM440 198l80-8-31 86zM710 172l80-8-31 86z" ${common}/>` ,
    snow: `<g stroke="${accent}" stroke-width="9" opacity=".3"><path d="M100 240v100m-43-75l86 50m0-50l-86 50M960 680v110m-48-83l96 56m0-56l-96 56"/></g>` ,
    fireworks: `<g stroke="${accent}" stroke-width="10" opacity=".3"><path d="M120 290l-65-65m65 65l65-65m-65 65v-95m0 95h95M920 720l-70-70m70 70l70-70m-70 70v-100"/></g>` ,
    lightning: `<path d="M115 225h95l-55 90h66L95 450l31-105H62zM940 690h72l-42 68h50l-96 103 24-80h-50z" ${common}/>` ,
    lines: `<path d="M-80 310L500 80M620 1920l540-330" stroke="${accent}" stroke-width="55" opacity=".15"/>`,
    independence: `<g opacity=".28"><path d="M-80 340L1160 30" stroke="${accent}" stroke-width="34"/><path d="M-80 430L1160 120" stroke="#ffffff" stroke-width="13"/><path d="M80 1650L1150 1380" stroke="${accent}" stroke-width="30"/><path d="M70 1730L1150 1460" stroke="#ffffff" stroke-width="12"/><path d="M540 110l88 42-88 42-88-42z" fill="#002776"/><circle cx="540" cy="152" r="25" fill="none" stroke="#ffffff" stroke-width="7"/></g>`,
    tags: `<path d="M70 240h155l65 65-155 155-65-65zm850 470h100l42 42-100 100-42-42z" ${common}/>` ,
    spark: `<path d="M110 260l20 52 52 20-52 20-20 52-20-52-52-20 52-20zm850 470l15 40 40 15-40 15-15 40-15-40-40-15 40-15z" ${common}/>`
  };
  return shapes[theme.decoration] || shapes.spark;
}

async function logoBuffer(size = 118) {
  for (const candidate of ['favicon-original.png', 'favicon-512.png']) {
    try {
      return await sharp(path.join(root, 'public', candidate)).resize(size, size, { fit: 'contain' }).png().toBuffer();
    } catch { /* tenta o próximo */ }
  }
  return null;
}

export function instagramAssetPath(fileName) {
  if (!MEDIA_FILE.test(String(fileName || ''))) return '';
  return path.join(mediaDir, path.basename(fileName));
}

export async function cleanupInstagramAssets(maximumAgeHours = 72) {
  await fs.mkdir(mediaDir, { recursive: true });
  const files = await fs.readdir(mediaDir, { withFileTypes: true });
  const threshold = Date.now() - Math.max(24, Number(maximumAgeHours || 72)) * 60 * 60 * 1000;
  await Promise.all(files.filter((entry) => entry.isFile() && MEDIA_FILE.test(entry.name)).map(async (entry) => {
    const file = path.join(mediaDir, entry.name);
    const stat = await fs.stat(file);
    if (stat.mtimeMs < threshold) await fs.unlink(file).catch(() => {});
  }));
}

export async function generateInstagramStory(story, config, requestedThemeId = '') {
  await fs.mkdir(mediaDir, { recursive: true });
  const theme = selectInstagramTheme(config, new Date(), requestedThemeId || story.themeId);
  // Keep dedicated vertical areas for the title, price and CTA. Marketplace
  // titles can be very long, so cap them at two lines to prevent overlap.
  const titleLines = splitLines(story.title, 34, 2);
  const price = money(story.price);
  const originalPrice = money(story.originalPrice);
  const discount = Math.max(0, Math.round(Number(story.discount || 0)));
  const store = String(story.store || 'Oferta').toUpperCase().slice(0, 28);
  const shareProfile = String(story.shareProfile || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._]/g, '').slice(0, 40);
  const headerSubtitle = escapeXml(shareProfile ? `Siga @${shareProfile}` : 'OFERTA SELECIONADA');
  const domain = String(config.canonicalUrl || 'https://promoshop.jhonatafaraujo.com.br').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const titleTspans = titleLines.map((line, index) => `<tspan x="92" dy="${index ? 62 : 0}">${escapeXml(line)}</tspan>`).join('');
  const disclosure = escapeXml(config.instagramDisclosureText || 'Publicidade · link de afiliado');
  const cta = escapeXml(config.instagramCtaText || 'Acesse o link da bio');
  const showQrCode = Boolean(config.instagramShowQrCode && validHttps(story.link));
  const domainX = showQrCode ? 420 : 540;
  const disclosureY = showQrCode ? 1870 : 1838;

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-opacity=".2"/></filter></defs>
    <rect width="1080" height="1920" fill="url(#bg)"/>
    ${decorationSvg(theme)}
    <text x="220" y="118" font-family="Arial,sans-serif" font-size="52" font-weight="800" fill="${theme.text}">PromoShop</text>
    <text x="220" y="161" font-family="Arial,sans-serif" font-size="26" font-weight="600" fill="${theme.text}" opacity=".84">${headerSubtitle}</text>
    <rect x="72" y="238" width="936" height="870" rx="58" fill="#ffffff" filter="url(#shadow)"/>
    <rect x="92" y="1138" width="250" height="56" rx="28" fill="${theme.accent}"/>
    <text x="217" y="1176" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="800" fill="#111827">${escapeXml(store)}</text>
    ${discount > 0 ? `<rect x="764" y="1138" width="244" height="56" rx="28" fill="${theme.accent}"/><text x="886" y="1176" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="900" fill="#111827">${discount}% OFF</text>` : ''}
    <text x="92" y="1270" font-family="Arial,sans-serif" font-size="50" font-weight="800" fill="${theme.text}">${titleTspans}</text>
    ${originalPrice ? `<text x="92" y="1432" font-family="Arial,sans-serif" font-size="30" fill="${theme.text}" opacity=".72">De ${escapeXml(originalPrice)}</text><line x1="142" y1="1422" x2="${145 + originalPrice.length * 17}" y2="1422" stroke="${theme.accent}" stroke-width="5"/>` : ''}
    <text x="92" y="1510" font-family="Arial,sans-serif" font-size="76" font-weight="900" fill="${theme.text}">${escapeXml(price || 'Confira a oferta')}</text>
    <rect x="72" y="1570" width="936" height="116" rx="38" fill="${theme.accent}"/>
    <text x="540" y="1643" text-anchor="middle" font-family="Arial,sans-serif" font-size="40" font-weight="900" fill="#111827">${cta}  →</text>
    <text x="${domainX}" y="1772" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    <text x="540" y="${disclosureY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="${theme.text}" opacity=".72">${disclosure}</text>
  </svg>`);

  let product;
  try {
    const source = await fetchBuffer(story.image);
    if (source) product = await sharp(source).rotate().resize(820, 780, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
  } catch (error) {
    addBufferedLog(`Instagram: não foi possível preparar a imagem de ${story.title}: ${error.message}`, 'warning');
  }
  if (story.image && !product) throw new Error('Não foi possível carregar a imagem da oferta para montar o Story.');

  const logo = await logoBuffer();
  const composites = [];
  if (product) composites.push({ input: product, left: 130, top: 282 });
  if (logo) composites.push({ input: logo, left: 78, top: 55 });
  if (showQrCode) {
    const qr = await QRCode.toBuffer(story.link, { type: 'png', width: 150, margin: 1, color: { dark: '#111827', light: '#ffffff' } });
    // Keep the QR code in the footer column, below the CTA button.
    composites.push({ input: qr, left: 850, top: 1698 });
  }

  const fileName = `story-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const filePath = path.join(mediaDir, fileName);
  await sharp(svg).composite(composites).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(filePath);
  return { fileName, filePath, themeId: theme.id, width: 1080, height: 1920 };
}

export async function generateInstagramShareTemplate(options = {}, config = {}, requestedThemeId = '') {
  await fs.mkdir(mediaDir, { recursive: true });
  const theme = selectInstagramTheme(config, new Date(), requestedThemeId);
  const templateType = options.templateType === 'group' ? 'group' : options.templateType === 'site' ? 'site' : 'profile';
  const isSite = templateType === 'site';
  const profileMode = options.profileMode === 'none' ? 'none' : options.profileMode === 'auto' ? 'auto' : 'manual';
  const profile = profileMode === 'none'
    ? ''
    : String(options.profile || (profileMode === 'auto' ? options.automaticProfile : '') || 'sonapromoshop').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._]/g, '').slice(0, 40) || 'sonapromoshop';
  const groupName = svgText(String(options.groupName || 'Ofertas PromoShop')).slice(0, 100);
  const groupCode = String(options.groupCode || '').trim().toUpperCase().slice(0, 10);
  const defaultBio = templateType === 'group'
    ? `Ofertas selecionadas para ${groupName}\nReceba novidades e descontos\nEntre pelo link da bio`
    : isSite
      ? 'Ofertas e cupons selecionados\nPreços baixos todos os dias\nAchados das melhores lojas'
      : 'Ofertas e cupons selecionados\nDescontos de cair o queixo\nSó oferta boa de verdade\nAproveite antes de sumir';
  const bioMaxLines = templateType === 'group' ? 3 : 5;
  const bioCharacters = templateType === 'group' ? 34 : 60;
  const bioFontSize = templateType === 'group' ? 34 : 28;
  const bioLineGap = templateType === 'group' ? 52 : 46;
  const bioLines = splitParagraphLines(svgText(isSite ? (options.siteDescription || defaultBio) : (options.bio || defaultBio)), bioCharacters, bioMaxLines);
  const siteTitle = svgText(String(options.siteTitle || 'PromoShop - Ofertas Diárias')).slice(0, 100);
  const titleText = templateType === 'group' ? groupName : isSite ? siteTitle : profile ? `@${profile}` : '';
  const titleLines = splitLines(titleText, templateType === 'group' ? 28 : isSite ? 24 : 25, 2);
  const titleSize = templateType === 'group' ? 50 : isSite ? 50 : 62;
  const titleTspans = titleLines.map((line, index) => `<tspan x="540" dy="${index ? 72 : 0}">${escapeXml(line)}</tspan>`).join('');
  const groupLink = validHttps(options.groupLink);
  const showQrCode = Boolean(options.showQrCode && groupLink);
  const manualLinkPlacement = Boolean(options.manualLinkPlacement && (templateType === 'group' || isSite));
  const qrLabel = manualLinkPlacement ? '' : showQrCode ? 'Aponte a câmera para entrar' : 'Link do grupo na bio';
  const defaultCta = templateType === 'group' ? 'Conheça este grupo' : 'Conheça o perfil';
  const rawCta = Object.prototype.hasOwnProperty.call(options, 'ctaText') ? options.ctaText : defaultCta;
  const cta = escapeXml(svgText(String(rawCta || '').slice(0, 48)));
  const domainY = showQrCode ? 1700 : isSite ? 1600 : 1530;
  const titleY = templateType === 'group' ? 700 : isSite ? 700 : 735;
  const codeBadge = templateType === 'group' && groupCode
    ? `<rect x="445" y="830" width="190" height="56" rx="28" fill="${theme.accent}"/><text x="540" y="867" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="900" fill="#111827">${escapeXml(groupCode)}</text>`
    : '';
  const bioY = templateType === 'group' && groupCode ? 960 : 900;
  const profileFooter = profile ? `Siga @${profile}` : 'Siga @sonapromoshop';
  const siteLinkArea = isSite ? `<rect x="150" y="1140" width="780" height="150" rx="26" fill="#ffffff" stroke="#d0d5dd" stroke-width="4" stroke-dasharray="12 12"/>` : '';
  const ctaMarkup = !isSite && cta ? `<rect x="100" y="1220" width="880" height="118" rx="32" fill="${theme.accent}"/><text x="540" y="1292" text-anchor="middle" font-family="Arial, Noto Color Emoji, Segoe UI Emoji, sans-serif" font-size="38" font-weight="900" fill="#111827">${cta}  →</text>` : '';
  const bodyFont = 'Arial, Noto Color Emoji, Segoe UI Emoji, sans-serif';
  const bioMarkup = bioLines.map((line, index) => bioLineMarkup(line, bioY + (index * bioLineGap), bodyFont, bioFontSize)).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs><filter id="shadow"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-opacity=".22"/></filter><clipPath id="cardClip"><rect x="54" y="225" width="972" height="1500" rx="58"/></clipPath></defs>
    <rect width="1080" height="1920" fill="${theme.background}"/>
    <circle cx="1030" cy="160" r="250" fill="${theme.background2}" opacity=".52"/>
    <circle cx="40" cy="1800" r="210" fill="${theme.background2}" opacity=".35"/>
    ${decorationSvg(theme)}
    <text x="70" y="112" font-family="Arial,sans-serif" font-size="54" font-weight="900" fill="${theme.text}">PromoShop</text>
    <text x="70" y="153" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}" opacity=".82">${templateType === 'group' ? 'GRUPOS DE OFERTAS' : isSite ? 'PÁGINA OFICIAL' : 'OFERTAS E CUPONS TODOS OS DIAS'}</text>
    <rect x="54" y="225" width="972" height="1500" rx="58" fill="#ffffff" filter="url(#shadow)"/>
    <rect x="54" y="225" width="972" height="360" rx="58" fill="${theme.background2}"/>
    <rect x="54" y="435" width="972" height="150" fill="${theme.background2}"/>
    <rect x="54" y="585" width="972" height="1140" fill="#ffffff" clip-path="url(#cardClip)"/>
    <text x="540" y="303" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="800" fill="${theme.text}" opacity=".82">${templateType === 'group' ? 'GRUPO WHATSAPP' : isSite ? 'SITE OFICIAL' : 'PERFIL OFICIAL'}</text>
    <circle cx="540" cy="440" r="108" fill="#edf3ff"/>
    <text x="540" y="${titleY}" text-anchor="middle" font-family="${bodyFont}" font-size="${titleSize}" font-weight="900" fill="#101828">${titleTspans}</text>
    ${codeBadge}
    <line x1="170" y1="805" x2="910" y2="805" stroke="#e4e7ec" stroke-width="3"/>
    ${bioMarkup}
    ${siteLinkArea}
    ${ctaMarkup}
    ${!isSite ? `<text x="540" y="1450" text-anchor="middle" font-family="${bodyFont}" font-size="30" font-weight="800" fill="#475467">${escapeXml(templateType === 'group' ? qrLabel : profileFooter)}</text>` : ''}
    <text x="540" y="${domainY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" fill="#667085">promoshop.jhonatafaraujo.com.br</text>
  </svg>`);
  const logoSize = templateType === 'group' ? 210 : 230;
  const logo = await logoBuffer(logoSize);
  const composites = [];
  if (logo) composites.push({ input: logo, left: 540 - (logoSize / 2), top: 440 - (logoSize / 2) });
  if (showQrCode) {
    const qr = await QRCode.toBuffer(groupLink, { type: 'png', width: 180, margin: 1, color: { dark: '#111827', light: '#ffffff' } });
    composites.push({ input: qr, left: 450, top: 1485 });
  }
  const fileName = `share-${templateType}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const filePath = path.join(mediaDir, fileName);
  await sharp(svg).composite(composites).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(filePath);
  return { fileName, filePath, themeId: theme.id, width: 1080, height: 1920 };
}

export async function generateInstagramHighlightAsset(highlight = {}, config = {}, requestedThemeId = '', requestedVariant = 'cover') {
  await fs.mkdir(mediaDir, { recursive: true });
  const theme = selectInstagramTheme(config, new Date(), requestedThemeId);
  const variant = requestedVariant === 'story' ? 'story' : 'cover';
  const name = svgText(highlight.name || 'Destaque').slice(0, 30);
  const description = svgText(highlight.description || 'Confira as novidades da PromoShop.').slice(0, 180);
  const descriptionLines = splitLines(description, 38, 4);
  const descriptionMarkup = descriptionLines.map((line, index) => `<tspan x="540" dy="${index ? 54 : 0}">${escapeXml(line)}</tspan>`).join('');
  const domain = String(config.canonicalUrl || 'https://promoshop.jhonatafaraujo.com.br').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const iconColor = variant === 'cover' ? theme.background2 : '#1269f3';
  const centerY = variant === 'cover' ? 960 : 650;
  const safeGuide = variant === 'cover'
    ? `<circle cx="540" cy="960" r="390" fill="#ffffff" opacity=".08"/><circle cx="540" cy="960" r="310" fill="#ffffff" filter="url(#shadow)"/>`
    : `<rect x="80" y="310" width="920" height="1260" rx="64" fill="#ffffff" filter="url(#shadow)"/>`;
  const body = variant === 'cover'
    ? `<circle cx="540" cy="${centerY - 30}" r="170" fill="#edf3ff"/><g transform="translate(420 ${centerY - 150})">${highlightIconSvg(highlight.icon, iconColor)}</g><text x="540" y="${centerY + 245}" text-anchor="middle" font-family="Arial,sans-serif" font-size="76" font-weight="900" fill="${theme.background2}">${escapeXml(name)}</text><text x="540" y="${centerY + 310}" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#667085">PROMOSHOP</text>`
    : `<circle cx="540" cy="${centerY}" r="170" fill="#edf3ff"/><g transform="translate(420 ${centerY - 120})">${highlightIconSvg(highlight.icon, iconColor)}</g><text x="540" y="910" text-anchor="middle" font-family="Arial,sans-serif" font-size="78" font-weight="900" fill="#101828">${escapeXml(name)}</text><text x="540" y="1040" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="600" fill="#475467">${descriptionMarkup}</text><rect x="150" y="1310" width="780" height="112" rx="34" fill="${theme.accent}"/><text x="540" y="1380" text-anchor="middle" font-family="Arial,sans-serif" font-size="35" font-weight="900" fill="#111827">Veja este Destaque no perfil  →</text>`;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="18" stdDeviation="24" flood-opacity=".22"/></filter></defs>
    <rect width="1080" height="1920" fill="url(#bg)"/>
    ${decorationSvg(theme)}
    <text x="540" y="120" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="900" fill="${theme.text}">PromoShop</text>
    <text x="540" y="162" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="700" fill="${theme.text}" opacity=".82">${variant === 'cover' ? 'CAPA DE DESTAQUE' : 'CONHEÇA NOSSOS DESTAQUES'}</text>
    ${safeGuide}
    ${body}
    <text x="540" y="1810" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
  </svg>`);
  const logo = await logoBuffer(90);
  const fileName = `highlight-${variant}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const filePath = path.join(mediaDir, fileName);
  await sharp(svg).composite(logo ? [{ input: logo, left: 495, top: 188 }] : []).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(filePath);
  return { fileName, filePath, themeId: theme.id, width: 1080, height: 1920, variant };
}

function feedStorySnapshot(source = {}, kind = 'offer') {
  return kind === 'coupon'
    ? {
      sourceId: source.id || source.sourceId || '', kind: 'coupon', title: source.title || 'Cupom PromoShop', store: source.store || 'Loja',
      price: 0, originalPrice: 0, discount: source.discountType === 'percent' ? Number(source.discountValue || 0) : 0,
      image: source.image || '', link: source.shortUrl || source.link || ''
    }
    : {
      sourceId: source.id || source.sourceId || '', kind: 'offer', title: source.title || 'Oferta PromoShop', store: source.store || 'Loja',
      price: Number(source.price || 0), originalPrice: Number(source.originalPrice || 0), discount: Number(source.discount || 0),
      image: source.image || '', link: source.affiliateUrl || source.link || ''
    };
}

const DEFAULT_FEED_CAPTION = '🔥 Ofertas selecionadas do dia\n\n{offers}\n\n🔗 Acesse a bio do perfil\n\n#PromoShop #Ofertas #Promoção';

function localFeedSummary(stories = []) {
  const validStories = Array.isArray(stories) ? stories : [];
  const stores = [...new Set(validStories.map((story) => String(story.store || '').trim()).filter(Boolean))].slice(0, 3);
  const maxDiscount = Math.max(0, ...validStories.map((story) => Math.round(Number(story.discount || 0))));
  const hasCoupon = validStories.some((story) => story.kind === 'coupon');
  const storeLine = stores.length ? `🛍️ Seleção especial em ${stores.join(', ')}.` : '🛍️ Achados selecionados em lojas parceiras.';
  const discountLine = maxDiscount > 0 ? `💸 Oportunidades com até ${maxDiscount}% OFF.` : '💸 Preços especiais escolhidos para você.';
  return `${discountLine}\n${storeLine}${hasCoupon ? '\n🎟️ Confira também os cupons ativos.' : ''}`;
}

function localFeedCaption(stories = []) {
  const validStories = Array.isArray(stories) ? stories : [];
  const hasCoupon = validStories.some((story) => story.kind === 'coupon');
  const summary = localFeedSummary(validStories);
  const variants = [
    `🔥 Curadoria PromoShop do dia\n\n${summary}\n\n🔗 Acesse a bio do perfil\n\n#PromoShop #Ofertas #Promoção`,
    `✨ Achados que valem a pena conferir\n\n${summary}\n${hasCoupon ? '🎟️ Cupons e condições especiais disponíveis.' : '📌 Seleção atualizada com carinho.'}\n\n🔗 Veja os detalhes no link da bio\n\n#PromoShop #Achados #Descontos`,
    `⚡ Oportunidades selecionadas pela PromoShop\n\n${summary}\n${hasCoupon ? '' : '💰 Economize sem perder tempo procurando.\n'}\n🔗 Acesse a bio do perfil\n\n#PromoShop #OfertasDoDia #Economize`
  ];
  let hash = 0;
  for (const story of validStories) {
    for (const character of String(story.sourceId || story.store || '')) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  }
  return variants[Math.abs(hash) % variants.length];
}

export function sanitizeFeedCaption(value, stories = []) {
  const supplied = String(value || '').trim();
  const looksLikePreviousAutomaticCaption = /^🔥\s*Ofertas selecionadas do dia/i.test(supplied) && (/\n•\s/.test(supplied) || /\{offers\}/i.test(supplied));
  const useLocalModel = !supplied || supplied === DEFAULT_FEED_CAPTION || looksLikePreviousAutomaticCaption;
  let caption = useLocalModel ? localFeedCaption(stories) : supplied;
  const summary = localFeedSummary(stories);
  caption = caption.replace(/\{offers\}/gi, summary);
  caption = caption.replace(/\{count\}/gi, String(stories.length));
  caption = caption.replace(/https?:\/\/\S+/gi, 'acesse a bio do perfil');
  return caption.slice(0, 2200);
}

function selectFeedTemplate(story = {}, mode = 'rotating') {
  const templates = ['classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'];
  const normalizedMode = mode === 'original' ? 'classic' : mode;
  if (templates.includes(normalizedMode)) return normalizedMode;
  let hash = 0;
  for (const character of String(story.sourceId || story.title || '')) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  return templates[Math.abs(hash) % templates.length];
}

export async function generateInstagramFeedAsset(story, config, requestedThemeId = '', format = 'portrait') {
  await fs.mkdir(mediaDir, { recursive: true });
  const theme = selectInstagramTheme(config, new Date(), requestedThemeId || story.themeId);
  const square = format === 'square';
  const template = selectFeedTemplate(story, String(config.instagramFeedTemplateMode || 'rotating'));
  const width = 1080;
  const height = square ? 1080 : 1350;
  const price = money(story.price);
  const discount = Math.max(0, Math.round(Number(story.discount || 0)));
  const store = String(story.store || 'Oferta').toUpperCase().slice(0, 22);
  const domain = String(config.canonicalUrl || 'https://promoshop.jhonatafaraujo.com.br').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cta = 'Acesse a bio do perfil';
  let productWidth = square ? 820 : 820;
  let productHeight = square ? 300 : 510;
  let productLeft = 130;
  let productTop = square ? 130 : 225;
  let svgMarkup;

  if (template === 'classic') {
    // Modelo original: preserva exatamente a composição que já era usada.
    const cardY = square ? 90 : 170;
    const cardHeight = square ? 850 : 1100;
    productTop = cardY + (square ? 40 : 55);
    const titleLines = splitLines(story.title, square ? 32 : 38, square ? 2 : 3);
    const titleLineHeight = square ? 38 : 48;
    const titleY = productTop + productHeight + (square ? 108 : 115);
    const priceY = titleY + (titleLines.length * titleLineHeight) + (square ? 44 : 52);
    const ctaButtonY = priceY + (square ? 28 : 38);
    const ctaButtonHeight = square ? 72 : 86;
    const titleTspans = titleLines.map((line, index) => `<tspan x="92" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-opacity=".22"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>${decorationSvg(theme)}
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">OFERTAS SELECIONADAS TODOS OS DIAS</text>
      <rect x="54" y="${cardY}" width="972" height="${cardHeight}" rx="42" fill="#ffffff" filter="url(#shadow)"/>
      <rect x="92" y="${productTop + productHeight + 28}" width="210" height="48" rx="24" fill="${theme.accent}"/>
      <text x="197" y="${productTop + productHeight + 60}" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="900" fill="#111827">${escapeXml(store)}</text>
      ${discount > 0 ? `<rect x="780" y="${productTop + productHeight + 28}" width="220" height="48" rx="24" fill="${theme.accent}"/><text x="890" y="${productTop + productHeight + 60}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="900" fill="#111827">${discount}% OFF</text>` : ''}
      <text x="92" y="${titleY}" font-family="Arial,sans-serif" font-size="${square ? 32 : 40}" font-weight="900" fill="#101828">${titleTspans}</text>
      ${story.originalPrice ? `<text x="92" y="${priceY - 68}" text-decoration="line-through" font-family="Arial,sans-serif" font-size="26" fill="#667085">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <text x="92" y="${priceY}" font-family="Arial,sans-serif" font-size="${square ? 60 : 68}" font-weight="900" fill="${theme.background2}">${escapeXml(price || 'Confira a oferta')}</text>
      <rect x="92" y="${ctaButtonY}" width="896" height="${ctaButtonHeight}" rx="28" fill="${theme.accent}"/>
      <text x="540" y="${ctaButtonY + (square ? 46 : 54)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${square ? 24 : 30}" font-weight="900" fill="#111827">${cta} →</text>
      <text x="540" y="${height - 34}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    </svg>`;
  } else if (template === 'editorial') {
    // Editorial: composição de revista compacta, com leitura contínua e sem
    // grandes vazios entre a oferta e a chamada final.
    const cardY = square ? 55 : 150;
    const cardHeight = square ? 930 : 1050;
    const imageTop = square ? 185 : 255;
    productTop = imageTop;
    productWidth = square ? 820 : 500;
    productHeight = square ? 280 : 455;
    productLeft = square ? 130 : 92;
    const titleLines = splitLines(story.title, square ? 31 : 17, square ? 2 : 4);
    const titleLineHeight = square ? 36 : 42;
    const textX = square ? 92 : 650;
    const titleY = square ? 535 : 455;
    const detailsWidth = square ? 896 : 350;
    const priceY = square ? 700 : 700;
    const titleTspans = titleLines.map((line, index) => `<tspan x="${textX}" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-opacity=".18"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>${decorationSvg(theme)}
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">CURADORIA DE OFERTAS</text>
      <rect x="54" y="${cardY}" width="972" height="${cardHeight}" rx="42" fill="#ffffff" filter="url(#shadow)"/>
      <rect x="54" y="${cardY}" width="18" height="${cardHeight}" rx="9" fill="${theme.accent}"/>
      <text x="94" y="${cardY + 48}" font-family="Arial,sans-serif" font-size="20" font-weight="900" letter-spacing="2" fill="${theme.background2}">ESCOLHA DA PROMOSHOP</text>
      ${!square ? `<line x1="610" y1="${cardY + 105}" x2="610" y2="${cardY + 650}" stroke="#e4e7ec" stroke-width="3"/>` : ''}
      ${square ? `<rect x="92" y="${imageTop - 25}" width="896" height="${productHeight + 50}" rx="28" fill="#f2f4f7"/>` : ''}
      <rect x="${textX}" y="${square ? 475 : 290}" width="${square ? detailsWidth : 330}" height="44" rx="22" fill="${theme.accent}"/>
      <text x="${textX + (square ? 448 : 165)}" y="${square ? 504 : 320}" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="900" fill="#111827">${escapeXml(store)}</text>
      ${discount > 0 ? `<text x="${textX}" y="${square ? 590 : 390}" font-family="Arial,sans-serif" font-size="${square ? 42 : 34}" font-weight="900" fill="${theme.background2}">${discount}% OFF</text>` : ''}
      <text x="${textX}" y="${titleY}" font-family="Arial,sans-serif" font-size="${square ? 32 : 34}" font-weight="900" fill="#101828">${titleTspans}</text>
      ${story.originalPrice ? `<text x="${textX}" y="${priceY - 38}" text-decoration="line-through" font-family="Arial,sans-serif" font-size="24" fill="#667085">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <text x="${textX}" y="${priceY}" font-family="Arial,sans-serif" font-size="${square ? 58 : 52}" font-weight="900" fill="${theme.background2}">${escapeXml(price || 'Confira a oferta')}</text>
      ${!square ? `<rect x="92" y="790" width="896" height="92" rx="26" fill="#eef4ff"/><text x="540" y="847" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="900" letter-spacing="1" fill="${theme.background2}">ACHADO SELECIONADO PARA VOCÊ</text>` : ''}
      <rect x="92" y="${square ? 800 : 910}" width="896" height="82" rx="26" fill="${theme.accent}"/>
      <text x="540" y="${square ? 852 : 962}" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="900" fill="#111827">${cta} →</text>
      ${!square ? `<text x="540" y="1060" text-anchor="middle" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#667085">Confira antes que a oferta mude</text>` : ''}
      <text x="540" y="${height - 34}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    </svg>`;
  } else if (template === 'spotlight') {
    // Destaque: impacto visual, com a oferta em um painel azul e o preço como protagonista.
    const cardY = square ? 50 : 145;
    const cardHeight = square ? 940 : 1110;
    const imageTop = square ? 165 : 255;
    productTop = imageTop + 28;
    productWidth = square ? 820 : 820;
    productHeight = square ? 270 : 390;
    productLeft = 130;
    const titleLines = splitLines(story.title, square ? 30 : 34, 2);
    const titleLineHeight = square ? 38 : 48;
    const titleY = square ? 610 : 825;
    const priceBlockY = square ? 735 : 995;
    const ctaY = square ? 850 : 1110;
    const titleTspans = titleLines.map((line, index) => `<tspan x="92" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-opacity=".24"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>${decorationSvg(theme)}
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">OFERTA EM DESTAQUE</text>
      <rect x="54" y="${cardY}" width="972" height="${cardHeight}" rx="52" fill="${theme.background2}" filter="url(#shadow)"/>
      <text x="92" y="${cardY + 58}" font-family="Arial,sans-serif" font-size="24" font-weight="900" letter-spacing="3" fill="${theme.accent}">DESTAQUE PROMOSHOP</text>
      <rect x="92" y="${imageTop}" width="896" height="${productHeight + 56}" rx="34" fill="#ffffff"/>
      <rect x="92" y="${imageTop + productHeight + 78}" width="235" height="48" rx="24" fill="${theme.accent}"/>
      <text x="209" y="${imageTop + productHeight + 110}" text-anchor="middle" font-family="Arial,sans-serif" font-size="21" font-weight="900" fill="#111827">${escapeXml(store)}</text>
      ${discount > 0 ? `<text x="${square ? 760 : 780}" y="${imageTop + productHeight + 110}" font-family="Arial,sans-serif" font-size="30" font-weight="900" fill="${theme.accent}">${discount}% OFF</text>` : ''}
      <text x="92" y="${titleY}" font-family="Arial,sans-serif" font-size="${square ? 31 : 40}" font-weight="900" fill="#ffffff">${titleTspans}</text>
      ${story.originalPrice ? `<text x="92" y="${priceBlockY - 28}" text-decoration="line-through" font-family="Arial,sans-serif" font-size="24" fill="#dbeafe">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <rect x="92" y="${priceBlockY}" width="896" height="100" rx="28" fill="${theme.accent}"/>
      <text x="540" y="${priceBlockY + 67}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${square ? 52 : 62}" font-weight="900" fill="#111827">${escapeXml(price || 'Confira a oferta')}</text>
      <rect x="92" y="${ctaY}" width="896" height="78" rx="26" fill="#ffffff"/>
      <text x="540" y="${ctaY + 50}" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="900" fill="${theme.background2}">${cta} →</text>
      <text x="540" y="${height - 34}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    </svg>`;
  } else if (template === 'split') {
    // Split: capa com coluna de marca e área de produto, pensado para alternar
    // com o Editorial em um carrossel sem repetir a mesma silhueta.
    const cardY = square ? 55 : 150;
    const cardHeight = square ? 930 : 1110;
    const imageTop = square ? 190 : 265;
    productTop = imageTop;
    productWidth = square ? 500 : 530;
    productHeight = square ? 260 : 430;
    productLeft = square ? 290 : 410;
    const titleLines = splitLines(story.title, square ? 31 : 22, square ? 2 : 3);
    const titleLineHeight = square ? 38 : 46;
    const titleX = square ? 92 : 410;
    const titleY = square ? 550 : 820;
    const priceY = square ? 710 : 1005;
    const titleTspans = titleLines.map((line, index) => `<tspan x="${titleX}" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-opacity=".2"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>${decorationSvg(theme)}
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">ACHADO DO DIA</text>
      <rect x="54" y="${cardY}" width="972" height="${cardHeight}" rx="42" fill="#ffffff" filter="url(#shadow)"/>
      <rect x="54" y="${cardY}" width="320" height="${cardHeight}" rx="42" fill="${theme.background2}"/>
      <rect x="300" y="${cardY}" width="74" height="${cardHeight}" fill="${theme.background2}"/>
      <text x="92" y="${cardY + 70}" font-family="Arial,sans-serif" font-size="22" font-weight="900" letter-spacing="2" fill="${theme.accent}">PROMOSHOP</text>
      <text x="92" y="${cardY + 190}" font-family="Arial,sans-serif" font-size="${square ? 48 : 58}" font-weight="900" fill="#ffffff">${discount > 0 ? `${discount}%` : 'OFERTA'}</text>
      <text x="92" y="${cardY + 245}" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#ffffff">${discount > 0 ? 'DE DESCONTO' : 'ESPECIAL'}</text>
      <text x="92" y="${cardY + 330}" font-family="Arial,sans-serif" font-size="20" font-weight="800" fill="${theme.accent}">SELECIONADA</text>
      <rect x="92" y="${cardY + 370}" width="220" height="44" rx="22" fill="${theme.accent}"/>
      <text x="202" y="${cardY + 399}" text-anchor="middle" font-family="Arial,sans-serif" font-size="19" font-weight="900" fill="#111827">${escapeXml(store)}</text>
      <rect x="${productLeft - 18}" y="${imageTop - 18}" width="${productWidth + 36}" height="${productHeight + 36}" rx="30" fill="#f2f4f7"/>
      <text x="${titleX}" y="${titleY - 60}" font-family="Arial,sans-serif" font-size="19" font-weight="900" letter-spacing="2" fill="${theme.background2}">OFERTA SELECIONADA</text>
      <text x="${titleX}" y="${titleY}" font-family="Arial,sans-serif" font-size="${square ? 31 : 36}" font-weight="900" fill="#101828">${titleTspans}</text>
      ${story.originalPrice ? `<text x="${titleX}" y="${priceY - 48}" text-decoration="line-through" font-family="Arial,sans-serif" font-size="24" fill="#667085">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <text x="${titleX}" y="${priceY}" font-family="Arial,sans-serif" font-size="${square ? 56 : 64}" font-weight="900" fill="${theme.background2}">${escapeXml(price || 'Confira a oferta')}</text>
      <rect x="${titleX}" y="${square ? 785 : 1090}" width="${square ? 580 : 550}" height="78" rx="25" fill="${theme.accent}"/>
      <text x="${titleX + (square ? 290 : 275)}" y="${square ? 835 : 1140}" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="900" fill="#111827">${cta} →</text>
      <text x="540" y="${height - 34}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    </svg>`;
  } else if (template === 'showcase') {
    // Vitrine: produto amplo, moldura suave e informações concentradas abaixo.
    const cardY = square ? 55 : 150;
    const cardHeight = square ? 930 : 1110;
    productTop = square ? 260 : 270;
    productWidth = 820;
    productHeight = square ? 280 : 480;
    productLeft = 130;
    const titleLines = splitLines(story.title, square ? 31 : 38, 2);
    const titleLineHeight = square ? 38 : 46;
    const titleY = square ? 610 : 835;
    const priceY = square ? 775 : 1015;
    const ctaY = square ? 860 : 1120;
    const titleTspans = titleLines.map((line, index) => `<tspan x="92" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-opacity=".2"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>${decorationSvg(theme)}
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">VITRINE DE OFERTAS</text>
      <rect x="54" y="${cardY}" width="972" height="${cardHeight}" rx="46" fill="#ffffff" filter="url(#shadow)"/>
      <rect x="92" y="${cardY + 32}" width="250" height="48" rx="24" fill="${theme.background2}"/>
      <text x="217" y="${cardY + 64}" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="900" fill="#ffffff">${escapeXml(store)}</text>
      ${discount > 0 ? `<rect x="780" y="${cardY + 28}" width="220" height="56" rx="28" fill="${theme.accent}"/><text x="890" y="${cardY + 65}" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="900" fill="#111827">${discount}% OFF</text>` : ''}
      <rect x="92" y="${productTop - 22}" width="896" height="${productHeight + 44}" rx="34" fill="#f2f4f7"/>
      <text x="92" y="${titleY}" font-family="Arial,sans-serif" font-size="${square ? 31 : 39}" font-weight="900" fill="#101828">${titleTspans}</text>
      ${story.originalPrice ? `<text x="92" y="${priceY - 55}" text-decoration="line-through" font-family="Arial,sans-serif" font-size="24" fill="#667085">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <text x="92" y="${priceY}" font-family="Arial,sans-serif" font-size="${square ? 56 : 66}" font-weight="900" fill="${theme.background2}">${escapeXml(price || 'Confira a oferta')}</text>
      <rect x="92" y="${ctaY}" width="896" height="82" rx="27" fill="${theme.accent}"/>
      <text x="540" y="${ctaY + 52}" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="900" fill="#111827">${cta} →</text>
      <text x="540" y="${height - 34}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    </svg>`;
  } else if (template === 'minimal') {
    // Essencial: visual claro e arejado, sem o cartão tradicional.
    productTop = 275;
    productWidth = 700;
    productHeight = square ? 300 : 430;
    productLeft = 190;
    const titleLines = splitLines(story.title, square ? 32 : 36, 2);
    const titleLineHeight = square ? 38 : 48;
    const titleY = square ? 610 : 780;
    const priceY = square ? 785 : 995;
    const ctaY = square ? 875 : 1105;
    const titleTspans = titleLines.map((line, index) => `<tspan x="540" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="header" x1="0" y1="0" x2="1" y2="0"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-opacity=".14"/></filter></defs>
      <rect width="${width}" height="${height}" fill="#f8fafc"/>
      <rect width="${width}" height="150" fill="url(#header)"/>
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">ESCOLHA ESSENCIAL</text>
      <rect x="70" y="180" width="940" height="${square ? 800 : 1080}" rx="48" fill="#ffffff" stroke="#dbe7ff" stroke-width="4" filter="url(#shadow)"/>
      <rect x="390" y="195" width="300" height="48" rx="24" fill="${theme.background2}"/>
      <text x="540" y="227" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="900" fill="#ffffff">${escapeXml(store)}</text>
      <rect x="130" y="${productTop - 22}" width="820" height="${productHeight + 44}" rx="42" fill="#eef4ff"/>
      ${discount > 0 ? `<circle cx="120" cy="${productTop + 35}" r="52" fill="${theme.accent}"/><text x="120" y="${productTop + 28}" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="900" fill="#111827">${discount}%</text><text x="120" y="${productTop + 52}" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" font-weight="900" fill="#111827">OFF</text>` : ''}
      <text x="540" y="${titleY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${square ? 31 : 39}" font-weight="900" fill="#101828">${titleTspans}</text>
      ${story.originalPrice ? `<text x="540" y="${priceY - 56}" text-anchor="middle" text-decoration="line-through" font-family="Arial,sans-serif" font-size="24" fill="#667085">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <text x="540" y="${priceY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${square ? 58 : 68}" font-weight="900" fill="${theme.background2}">${escapeXml(price || 'Confira a oferta')}</text>
      <rect x="170" y="${ctaY}" width="740" height="82" rx="41" fill="none" stroke="${theme.background2}" stroke-width="5"/>
      <text x="540" y="${ctaY + 52}" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="900" fill="${theme.background2}">${cta} →</text>
      <text x="540" y="${height - 32}" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="700" fill="${theme.background2}">${escapeXml(domain)}</text>
    </svg>`;
  } else {
    // Oferta relâmpago: bloco de desconto lateral e contraste alto.
    const cardY = square ? 55 : 150;
    const cardHeight = square ? 930 : 1110;
    productTop = square ? 220 : 285;
    productWidth = square ? 590 : 600;
    productHeight = square ? 300 : 440;
    productLeft = square ? 95 : 100;
    const titleLines = splitLines(story.title, square ? 30 : 36, 2);
    const titleLineHeight = square ? 38 : 48;
    const titleY = square ? 625 : 820;
    const priceY = square ? 790 : 1010;
    const ctaY = square ? 880 : 1110;
    const titleTspans = titleLines.map((line, index) => `<tspan x="92" dy="${index ? titleLineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
    svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="${theme.background2}"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-opacity=".25"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>${decorationSvg(theme)}
      <text x="76" y="82" font-family="Arial,sans-serif" font-size="44" font-weight="900" fill="${theme.text}">PromoShop</text>
      <text x="76" y="119" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${theme.text}" opacity=".82">OFERTA RELÂMPAGO</text>
      <rect x="54" y="${cardY}" width="972" height="${cardHeight}" rx="48" fill="${theme.background2}" filter="url(#shadow)"/>
      <rect x="92" y="${cardY + 35}" width="250" height="48" rx="24" fill="#ffffff"/>
      <text x="217" y="${cardY + 67}" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="900" fill="${theme.background2}">${escapeXml(store)}</text>
      <rect x="75" y="${productTop - 25}" width="650" height="${productHeight + 50}" rx="36" fill="#ffffff"/>
      <rect x="755" y="${productTop - 25}" width="240" height="${productHeight + 50}" rx="36" fill="${theme.accent}"/>
      <text x="875" y="${productTop + 135}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${discount > 0 ? (square ? 62 : 70) : 42}" font-weight="900" fill="#111827">${discount > 0 ? `${discount}%` : 'ACHADO'}</text>
      <text x="875" y="${productTop + 190}" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="900" fill="#111827">${discount > 0 ? 'OFF' : 'DO DIA'}</text>
      <path d="M820 ${productTop + 270}h110" stroke="#111827" stroke-width="5" stroke-linecap="round" opacity=".25"/>
      <text x="875" y="${productTop + 330}" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="800" fill="#111827">APROVEITE</text>
      <text x="92" y="${titleY}" font-family="Arial,sans-serif" font-size="${square ? 31 : 40}" font-weight="900" fill="#ffffff">${titleTspans}</text>
      ${story.originalPrice ? `<text x="92" y="${priceY - 58}" text-decoration="line-through" font-family="Arial,sans-serif" font-size="24" fill="#dbeafe">De ${escapeXml(money(story.originalPrice))}</text>` : ''}
      <text x="92" y="${priceY}" font-family="Arial,sans-serif" font-size="${square ? 58 : 68}" font-weight="900" fill="${theme.accent}">${escapeXml(price || 'Confira a oferta')}</text>
      <rect x="92" y="${ctaY}" width="896" height="82" rx="28" fill="#ffffff"/>
      <text x="540" y="${ctaY + 52}" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="900" fill="${theme.background2}">${cta} →</text>
      <text x="540" y="${height - 34}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="${theme.text}">${escapeXml(domain)}</text>
    </svg>`;
  }
  const svg = Buffer.from(svgMarkup);
  let product;
  try {
    const source = await fetchBuffer(story.image);
    if (source) product = await sharp(source).rotate().resize(productWidth, productHeight, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
  } catch (error) {
    addBufferedLog(`Instagram Feed: não foi possível preparar a imagem de ${story.title}: ${error.message}`, 'warning');
  }
  if (story.image && !product) throw new Error('Não foi possível carregar a imagem da oferta para montar o Feed.');
  const logo = await logoBuffer(106);
  const composites = [];
  if (product) composites.push({ input: product, left: productLeft, top: productTop });
  if (logo) composites.push({ input: logo, left: 900, top: 34 });
  const fileName = `feed-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const filePath = path.join(mediaDir, fileName);
  await sharp(svg).composite(composites).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(filePath);
  return { fileName, filePath, themeId: theme.id, template, width, height };
}

function storySnapshot(data, queueItem) {
  const offer = data.offers.find((entry) => entry.id === queueItem.offerId) || queueItem.offerSnapshot || {};
  const coupon = queueItem.couponSnapshot || {};
  return queueItem.kind === 'coupon'
    ? { kind: 'coupon', sourceId: queueItem.couponId || queueItem.id, title: coupon.title || queueItem.offerTitle, store: coupon.store || queueItem.store, price: 0, originalPrice: 0, discount: coupon.discountType === 'percent' ? coupon.discountValue : 0, image: coupon.image || queueItem.image, link: coupon.shortUrl || coupon.link, audienceCodes: queueItem.targetAudienceCodes || [], sourcePublishedAt: queueItem.sentAt || queueItem.createdAt || new Date().toISOString() }
    : { kind: 'offer', sourceId: queueItem.offerId, title: offer.title || queueItem.offerTitle, store: offer.store || queueItem.store, price: offer.price, originalPrice: offer.originalPrice, discount: offer.discount, image: offer.image || queueItem.image, link: offer.affiliateUrl || queueItem.link, audienceCodes: queueItem.targetAudienceCodes || [], sourcePublishedAt: queueItem.sentAt || queueItem.createdAt || new Date().toISOString() };
}

export function enqueueInstagramFromWhatsapp(data, queueItem) {
  const config = data.config || {};
  data.instagramQueue ||= [];
  if (config.instagramEnabled !== true || config.instagramAutoFromWhatsapp !== true) return null;
  const story = storySnapshot(data, queueItem);
  if (story.kind === 'coupon' && config.instagramIncludeCoupons !== true) return null;
  if (!story.title || !validHttps(story.image) || !validHttps(story.link)) return null;
  const stores = Array.isArray(config.instagramStores) ? config.instagramStores.map((entry) => String(entry).toLowerCase()) : [];
  if (stores.length && !stores.includes(String(story.store || '').toLowerCase())) return null;
  const audiences = Array.isArray(config.instagramAudienceCodes) ? config.instagramAudienceCodes : [];
  if (audiences.length && !story.audienceCodes.some((code) => audiences.includes(code))) return null;
  if (story.kind === 'offer' && Number(story.discount || 0) < Number(config.instagramMinimumDiscount || 0)) return null;

  const cooldown = Math.max(1, Number(config.instagramDuplicateDays || 7)) * DAY;
  const duplicate = data.instagramQueue.some((entry) => entry.sourceId === story.sourceId && entry.kind === story.kind && Date.now() - new Date(entry.createdAt || 0).getTime() < cooldown && !['cancelled', 'failed'].includes(entry.status));
  if (duplicate) return null;

  const item = {
    id: createId('instagram'),
    ...story,
    status: 'pending',
    attempts: 0,
    force: false,
    createdAt: new Date().toISOString(),
    publishedAt: null,
    retryAt: null,
    error: null,
    mediaId: '',
    containerId: '',
    assetFileName: '',
    themeId: ''
  };
  data.instagramQueue.push(item);
  return item;
}

export function enqueueInstagramFeedFromWhatsapp(data, queueItem) {
  const config = data.config || {};
  data.instagramFeedQueue ||= [];
  if (config.instagramFeedEnabled !== true || config.instagramFeedAutoFromWhatsapp !== true) return null;
  const story = storySnapshot(data, queueItem);
  if (story.kind === 'coupon' && config.instagramIncludeCoupons !== true) return null;
  if (!story.title || !validHttps(story.image)) return null;
  const stores = Array.isArray(config.instagramStores) ? config.instagramStores.map((entry) => String(entry).toLowerCase()) : [];
  if (stores.length && !stores.includes(String(story.store || '').toLowerCase())) return null;
  const audiences = Array.isArray(config.instagramAudienceCodes) ? config.instagramAudienceCodes : [];
  if (audiences.length && !story.audienceCodes.some((code) => audiences.includes(code))) return null;
  if (story.kind === 'offer' && Number(story.discount || 0) < Number(config.instagramFeedMinimumDiscount || 0)) return null;
  const cooldown = Math.max(1, Number(config.instagramFeedDuplicateDays || 7)) * DAY;
  const duplicate = data.instagramFeedQueue.some((entry) => (entry.sourceIds || []).includes(story.sourceId) && Date.now() - new Date(entry.createdAt || 0).getTime() < cooldown && !['cancelled', 'failed'].includes(entry.status));
  if (duplicate) return null;
  if (config.instagramFeedPostType === 'carousel') {
    const batch = data.instagramFeedQueue.find((entry) => entry.status === 'pending' && entry.postType === 'carousel' && (entry.items || []).length < Math.max(2, Math.min(10, Number(config.instagramFeedCarouselSize || 4))));
    if (batch) {
      batch.items.push(story);
      batch.sourceIds.push(story.sourceId);
      batch.latestSourceAt = story.sourcePublishedAt || new Date().toISOString();
      batch.templateMode ||= String(config.instagramFeedTemplateMode || 'rotating');
      batch.title = `Carrossel com ${batch.items.length} ofertas`;
      batch.caption = sanitizeFeedCaption(config.instagramFeedCaption, batch.items);
      return batch;
    }
  }
  const item = {
    id: createId('instagram-feed'), postType: config.instagramFeedPostType === 'carousel' ? 'carousel' : 'single', format: config.instagramFeedFormat === 'square' ? 'square' : 'portrait',
    items: [story], sourceIds: [story.sourceId], title: story.title, store: story.store,
    caption: sanitizeFeedCaption(config.instagramFeedCaption, [story]), status: 'pending', attempts: 0, force: false,
    origin: 'whatsapp', latestSourceAt: story.sourcePublishedAt || new Date().toISOString(),
    templateMode: String(config.instagramFeedTemplateMode || 'rotating'),
    createdAt: new Date().toISOString(), scheduledFor: null, publishedAt: null, retryAt: null, error: null,
    mediaIds: [], assetFileNames: [], themeId: ''
  };
  data.instagramFeedQueue.push(item);
  return item;
}

export function backfillInstagramFeedFromRecentWhatsapp(data) {
  const config = data.config || {};
  if (config.instagramFeedEnabled !== true || config.instagramFeedAutoFromWhatsapp !== true) return 0;
  data.instagramFeedQueue ||= [];
  const carousel = config.instagramFeedPostType === 'carousel';
  const target = carousel
    ? Math.max(2, Math.min(10, Number(config.instagramFeedCarouselSize || 4)))
    : Math.max(1, Math.min(30, Number(config.instagramFeedMaxPerDay || 3)));
  const pendingCount = () => (data.instagramFeedQueue || [])
    .filter((entry) => entry.status === 'pending' && entry.origin === 'whatsapp' && entry.postType === (carousel ? 'carousel' : 'single'))
    .reduce((total, entry) => total + (carousel ? (entry.sourceIds || []).length : 1), 0);
  if (pendingCount() >= target) return 0;

  const maximumAge = Math.max(1, Number(config.instagramFeedDuplicateDays || 7)) * DAY;
  const recentSent = (data.queue || [])
    .filter((entry) => entry.status === 'sent' && Date.now() - new Date(entry.sentAt || entry.createdAt || 0).getTime() <= maximumAge)
    .sort((a, b) => new Date(b.sentAt || b.createdAt || 0).getTime() - new Date(a.sentAt || a.createdAt || 0).getTime())
    .slice(0, 300);
  let added = 0;
  for (const queueItem of recentSent) {
    const before = (data.instagramFeedQueue || []).reduce((total, entry) => total + (entry.sourceIds || []).length, 0);
    enqueueInstagramFeedFromWhatsapp(data, queueItem);
    const after = (data.instagramFeedQueue || []).reduce((total, entry) => total + (entry.sourceIds || []).length, 0);
    if (after > before) added += after - before;
    if (pendingCount() >= target) break;
  }
  return added;
}

async function metaJson(url, options = {}) {
  const { retryAttempts: requestedRetries, timeoutMs: requestedTimeout, ...fetchOptions } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const retryAttempts = Math.max(0, Math.min(2, Number(requestedRetries ?? (method === 'GET' ? 2 : 0))));
  const timeoutMs = Math.max(30_000, Math.min(120_000, Number(requestedTimeout || META_REQUEST_TIMEOUT_MS)));

  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      const text = await readTextLimited(response);
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 400) }; }
      if (!response.ok || body.error) {
        const error = new Error(body.error?.message || body.message || `Meta respondeu ${response.status}`);
        error.metaCode = body.error?.code || body.code || response.status;
        error.httpStatus = response.status;
        error.instagramRateLimited = isInstagramRateLimitError(error);
        throw error;
      }
      return body;
    } catch (error) {
      const rateLimited = Boolean(error?.instagramRateLimited) || isInstagramRateLimitError(error);
      if (!rateLimited && isTransientMetaError(error) && attempt < retryAttempts) {
        await wait(1500 * (attempt + 1));
        continue;
      }
      if (error?.name === 'AbortError') {
        throw new Error(`A Meta não respondeu dentro de ${Math.round(timeoutMs / 1000)} segundos.`);
      }
      if (error instanceof TypeError && /fetch failed/i.test(String(error.message || ''))) {
        throw new Error('Falha temporária de conexão com a Meta.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('A Meta não respondeu à solicitação.');
}

function metaBearerJson(url, accessToken, options = {}) {
  return metaJson(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
  });
}

export async function testInstagramConnection(config, secrets) {
  if (!secrets.instagramAccessToken) throw new Error('Conecte a conta do Instagram primeiro.');
  return metaBearerJson(`${graphUrl(config, '/me')}?fields=user_id,username,name,profile_picture_url`, secrets.instagramAccessToken);
}

export async function beginInstagramAuthorization(config, secrets) {
  if (!secrets.instagramAppId || !secrets.instagramAppSecret) throw new Error('Informe o ID e a chave secreta do aplicativo da Meta.');
  const redirectUri = validHttps(config.instagramRedirectUri);
  if (!redirectUri) throw new Error('Informe uma URL HTTPS válida para o retorno do Instagram.');
  const state = crypto.randomBytes(24).toString('hex');
  await updateSecrets({ instagramOAuthState: state, instagramOAuthStateExpiresAt: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    enable_fb_login: '0',
    force_authentication: '1',
    client_id: secrets.instagramAppId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_content_publish',
    state
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export async function finishInstagramAuthorization(config, secrets, query) {
  if (!query.code || !query.state || query.state !== secrets.instagramOAuthState || Number(secrets.instagramOAuthStateExpiresAt || 0) < Date.now()) throw new Error('A confirmação do Instagram expirou ou não é válida.');
  const redirectUri = validHttps(config.instagramRedirectUri);
  const form = new URLSearchParams({ client_id: secrets.instagramAppId, client_secret: secrets.instagramAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: String(query.code).replace(/#_$/, '') });
  const shortToken = await metaJson('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const longToken = await metaJson(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(secrets.instagramAppSecret)}&access_token=${encodeURIComponent(shortToken.access_token)}`);
  const accessToken = longToken.access_token || shortToken.access_token;
  const profile = await metaBearerJson(`${graphUrl(config, '/me')}?fields=user_id,username,name,profile_picture_url`, accessToken);
  await updateSecrets({
    instagramAccessToken: accessToken,
    instagramUserId: String(profile.user_id || shortToken.user_id || profile.id || ''),
    instagramUsername: String(profile.username || ''),
    instagramProfilePictureUrl: String(profile.profile_picture_url || ''),
    instagramTokenExpiresAt: Date.now() + Number(longToken.expires_in || 5184000) * 1000,
    instagramOAuthState: '',
    instagramOAuthStateExpiresAt: 0
  });
  return profile;
}

export async function refreshInstagramToken(secrets) {
  if (!secrets.instagramAccessToken) throw new Error('Instagram não conectado.');
  const result = await metaJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(secrets.instagramAccessToken)}`);
  await updateSecrets({ instagramAccessToken: result.access_token || secrets.instagramAccessToken, instagramTokenExpiresAt: Date.now() + Number(result.expires_in || 5184000) * 1000 });
  return result;
}

export function verifyInstagramSignedRequest(value, appSecret) {
  const [encodedSignature, payload] = String(value || '').split('.', 2);
  if (!encodedSignature || !payload || !appSecret) throw new Error('Solicitação assinada inválida.');
  const received = Buffer.from(encodedSignature, 'base64url');
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('Assinatura da Meta não confere.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (String(parsed.algorithm || 'HMAC-SHA256').toUpperCase() !== 'HMAC-SHA256') throw new Error('Algoritmo de assinatura não permitido.');
  return parsed;
}

async function publishAsset(config, secrets, imageUrl) {
  const params = new URLSearchParams({ media_type: 'STORIES', image_url: imageUrl, access_token: secrets.instagramAccessToken });
  const container = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, retryAttempts: 1 });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await metaBearerJson(`${graphUrl(config, `/${container.id}`)}?fields=status_code`, secrets.instagramAccessToken);
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw new Error(`A Meta não conseguiu preparar o Story (${status.status_code}).`);
    if (attempt === 11) throw new Error('A Meta demorou demais para preparar o Story.');
  }
  const publish = new URLSearchParams({ creation_id: container.id, access_token: secrets.instagramAccessToken });
  const result = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media_publish`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: publish });
  return { containerId: container.id, mediaId: result.id };
}

async function waitForMediaContainer(config, secrets, containerId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const status = await metaBearerJson(`${graphUrl(config, `/${containerId}`)}?fields=status_code`, secrets.instagramAccessToken);
    if (!status.status_code || status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw new Error(`A Meta não conseguiu preparar a publicação (${status.status_code}).`);
    if (attempt === 11) throw new Error('A Meta demorou demais para preparar a publicação.');
  }
}

async function publishFeedPost(config, secrets, imageUrls, caption) {
  const urls = imageUrls.filter((url) => /^https:\/\//i.test(String(url || '')));
  if (!urls.length) throw new Error('Nenhuma imagem pública foi preparada para o Feed.');
  if (urls.length === 1) {
    const params = new URLSearchParams({ image_url: urls[0], caption: String(caption || '').slice(0, 2200), access_token: secrets.instagramAccessToken });
    const container = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, retryAttempts: 1 });
    await waitForMediaContainer(config, secrets, container.id);
    const publish = new URLSearchParams({ creation_id: container.id, access_token: secrets.instagramAccessToken });
    const result = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media_publish`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: publish });
    return { containerId: container.id, mediaId: result.id, childIds: [] };
  }

  const childIds = [];
  for (const imageUrl of urls.slice(0, 10)) {
    const childParams = new URLSearchParams({ image_url: imageUrl, is_carousel_item: 'true', access_token: secrets.instagramAccessToken });
    const child = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: childParams, retryAttempts: 1 });
    await waitForMediaContainer(config, secrets, child.id);
    childIds.push(child.id);
  }
  const carouselParams = new URLSearchParams({ media_type: 'CAROUSEL', children: childIds.join(','), caption: String(caption || '').slice(0, 2200), access_token: secrets.instagramAccessToken });
  const carousel = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: carouselParams, retryAttempts: 1 });
  await waitForMediaContainer(config, secrets, carousel.id);
  const publish = new URLSearchParams({ creation_id: carousel.id, access_token: secrets.instagramAccessToken });
  const result = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media_publish`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: publish });
  return { containerId: carousel.id, mediaId: result.id, childIds };
}

function withinSchedule(config, date = new Date()) {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const now = `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`;
  const start = /^\d{2}:\d{2}$/.test(config.instagramPublishingStart) ? config.instagramPublishingStart : '08:00';
  const end = /^\d{2}:\d{2}$/.test(config.instagramPublishingEnd) ? config.instagramPublishingEnd : '23:00';
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

function withinFeedSchedule(config, date = new Date()) {
  const timeZone = 'America/Sao_Paulo';
  const allowedDays = Array.isArray(config.instagramFeedPublishingDays) && config.instagramFeedPublishingDays.length
    ? config.instagramFeedPublishingDays.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [1, 3, 5];
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const weekdayNumbers = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (!allowedDays.includes(weekdayNumbers[weekday])) return false;
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const now = `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`;
  const start = /^\d{2}:\d{2}$/.test(config.instagramFeedPublishingStart) ? config.instagramFeedPublishingStart : '09:00';
  const end = /^\d{2}:\d{2}$/.test(config.instagramFeedPublishingEnd) ? config.instagramFeedPublishingEnd : '21:00';
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

function feedEntryFreshness(entry) {
  const itemDates = (entry?.items || []).map((item) => new Date(item.sourcePublishedAt || 0).getTime()).filter(Number.isFinite);
  return Math.max(new Date(entry?.latestSourceAt || 0).getTime(), new Date(entry?.createdAt || 0).getTime(), ...itemDates, 0);
}

// Quando o Feed é alimentado pelos envios do WhatsApp, cada promoção entra na
// fila no momento em que é confirmada. Antes de publicar, consolidamos os itens
// mais recentes em um único carrossel para que a arte não fique presa a uma
// promoção antiga enquanto novas ofertas já foram enviadas aos grupos.
function latestAutomaticCarousel(data, config) {
  if (config.instagramFeedPostType !== 'carousel') return null;
  const size = Math.max(2, Math.min(10, Number(config.instagramFeedCarouselSize || 4)));
  const candidates = (data.instagramFeedQueue || [])
    .filter((entry) => entry.status === 'pending' && entry.origin === 'whatsapp' && !entry.scheduledFor && (!entry.retryAt || new Date(entry.retryAt).getTime() <= Date.now()))
    .sort((a, b) => feedEntryFreshness(b) - feedEntryFreshness(a));
  if (!candidates.length) return null;

  const stories = [];
  const sourceIds = new Set();
  for (const entry of candidates) {
    for (const story of entry.items || []) {
      const sourceId = String(story.sourceId || '');
      if (!sourceId || sourceIds.has(sourceId)) continue;
      sourceIds.add(sourceId);
      stories.push(story);
      if (stories.length >= size) break;
    }
    if (stories.length >= size) break;
  }
  if (stories.length < 2) return null;
  stories.sort((a, b) => new Date(b.sourcePublishedAt || 0).getTime() - new Date(a.sourcePublishedAt || 0).getTime());
  const selected = candidates[0];
  const consumedIds = candidates.slice(1).filter((entry) => (entry.items || []).some((story) => sourceIds.has(String(story.sourceId || '')))).map((entry) => entry.id);
  return { selected, stories, sourceIds: [...sourceIds], consumedIds };
}

export async function processInstagramQueue({ forceId = '' } = {}) {
  if (processing || metaPublishing) return { busy: true };
  processing = true;
  metaPublishing = true;
  let selected = null;
  try {
    let [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const stalePublishing = (data.instagramQueue || []).some((item) => item.status === 'publishing' && Date.now() - new Date(item.publishingAt || item.createdAt || 0).getTime() > STALE_PUBLICATION_MS);
    if (stalePublishing) {
      await updateStore((fresh) => {
        for (const item of fresh.instagramQueue || []) {
          if (item.status === 'publishing' && Date.now() - new Date(item.publishingAt || item.createdAt || 0).getTime() > STALE_PUBLICATION_MS) {
            const uncertain = Boolean(item.metaPublishingStartedAt);
            Object.assign(item, { status: uncertain ? 'failed' : 'pending', publishingAt: null, retryAt: null, error: uncertain ? 'O servidor reiniciou depois de iniciar o envio à Meta. Confira o Instagram antes de tentar novamente para evitar duplicação.' : 'Publicação retomada após reinício do servidor.' });
          }
        }
      });
      data = await readStore();
      secrets = await readSecrets();
    }
    const config = data.config || {};
    if (!secrets.instagramAccessToken || !secrets.instagramUserId) return { connected: false };
    if (!forceId && (config.instagramEnabled !== true || !withinSchedule(config))) return { paused: true };
    const rateLimitUntil = instagramRateLimitUntil(data);
    if (rateLimitUntil > Date.now()) return { rateLimited: true, retryAt: new Date(rateLimitUntil).toISOString() };
    const sentLastDay = (data.instagramQueue || []).filter((item) => item.status === 'sent' && Date.now() - new Date(item.publishedAt || 0).getTime() < DAY);
    if (!forceId && sentLastDay.length >= Math.max(1, Number(config.instagramMaxPerDay || 15))) return { limited: true };
    const lastSentAt = sentLastDay.reduce((latest, item) => Math.max(latest, new Date(item.publishedAt || 0).getTime()), 0);
    if (!forceId && lastSentAt && Date.now() - lastSentAt < Math.max(1, Number(config.instagramIntervalMinutes || 20)) * 60_000) return { waiting: true };
    selected = forceId
      ? (data.instagramQueue || []).find((item) => item.id === forceId && item.status !== 'sent')
      : (data.instagramQueue || []).find((item) => item.status === 'pending' && (!item.retryAt || new Date(item.retryAt).getTime() <= Date.now()));
    if (!selected) return { empty: true };

    await updateStore((fresh) => {
      const item = (fresh.instagramQueue || []).find((entry) => entry.id === selected.id);
      if (item) { item.status = 'publishing'; item.publishingAt = new Date().toISOString(); item.error = null; }
    });
    const asset = selected.kind === 'highlight'
      ? await generateInstagramHighlightAsset(selected.highlight || selected, config, selected.themeId, 'story')
      : await generateInstagramStory(selected, config);
    const canonical = String(config.canonicalUrl || '').replace(/\/$/, '');
    if (!/^https:\/\//i.test(canonical)) throw new Error('Configure o domínio HTTPS do site antes de publicar Stories.');
    await updateStore((fresh) => {
      const item = (fresh.instagramQueue || []).find((entry) => entry.id === selected.id);
      if (item) item.metaPublishingStartedAt = new Date().toISOString();
    });
    const published = await publishAsset(config, secrets, `${canonical}/media/instagram/${asset.fileName}`);
    await updateStore((fresh) => {
      const item = (fresh.instagramQueue || []).find((entry) => entry.id === selected.id);
      if (!item) return;
      Object.assign(item, { status: 'sent', publishedAt: new Date().toISOString(), publishingAt: null, metaPublishingStartedAt: null, assetFileName: asset.fileName, themeId: asset.themeId, containerId: published.containerId, mediaId: published.mediaId, error: null, retryAt: null, instagramRateLimited: false });
      appendActivity(fresh, `Instagram: Story publicado — ${selected.title}.`, 'success');
    });
    return { ok: true, id: selected.id, ...published };
  } catch (error) {
    if (selected) {
      const rateLimited = Boolean(error?.instagramRateLimited) || isInstagramRateLimitError(error);
      await updateStore((fresh) => {
        const item = (fresh.instagramQueue || []).find((entry) => entry.id === selected.id);
        if (!item) return;
        item.attempts = Number(item.attempts || 0) + 1;
        const uncertain = Boolean(item.metaPublishingStartedAt);
        item.status = uncertain ? 'failed' : rateLimited ? 'pending' : item.attempts >= 3 ? 'failed' : 'pending';
        item.instagramRateLimited = rateLimited;
        item.error = uncertain
          ? 'O envio à Meta foi iniciado, mas não houve confirmação. Confira o Instagram antes de tentar novamente para evitar publicação duplicada.'
          : rateLimited
          ? 'A Meta limitou temporariamente as publicações por excesso de ações. A fila ficará pausada e tentará novamente mais tarde.'
          : String(error.message || error).slice(0, 500);
        item.publishingAt = null;
        const retryDelay = rateLimited
          ? Math.min(24, 6 * 2 ** Math.min(Math.max(0, item.attempts - 1), 2)) * 60 * 60_000
          : Math.min(60, 5 * 2 ** item.attempts) * 60_000;
        item.retryAt = item.status === 'pending' ? new Date(Date.now() + retryDelay).toISOString() : null;
        const retryLabel = formatInstagramRetryAt(item.retryAt);
        const message = rateLimited && retryLabel
          ? `Instagram: a Meta limitou temporariamente as ações. A fila foi pausada até aproximadamente ${retryLabel}.`
          : uncertain
            ? `Instagram: o envio de ${selected.title} foi iniciado, mas não houve confirmação da Meta. Confira o perfil antes de tentar novamente para evitar publicação duplicada.`
            : `Instagram: falha ao publicar ${selected.title}: ${error.message}`;
        appendActivity(fresh, message, rateLimited ? 'warning' : 'error');
      });
    }
    throw error;
  } finally {
    processing = false;
    metaPublishing = false;
  }
}

let feedProcessing = false;

export async function processInstagramFeedQueue({ forceId = '' } = {}) {
  if (feedProcessing || metaPublishing) return { busy: true };
  feedProcessing = true;
  metaPublishing = true;
  let selected = null;
  try {
    let [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const stalePublishing = (data.instagramFeedQueue || []).some((item) => item.status === 'publishing' && Date.now() - new Date(item.publishingAt || item.createdAt || 0).getTime() > STALE_PUBLICATION_MS);
    if (stalePublishing) {
      await updateStore((fresh) => {
        for (const item of fresh.instagramFeedQueue || []) {
          if (item.status === 'publishing' && Date.now() - new Date(item.publishingAt || item.createdAt || 0).getTime() > STALE_PUBLICATION_MS) {
            const uncertain = Boolean(item.metaPublishingStartedAt);
            Object.assign(item, { status: uncertain ? 'failed' : 'pending', publishingAt: null, retryAt: null, error: uncertain ? 'O servidor reiniciou depois de iniciar o envio à Meta. Confira o Instagram antes de tentar novamente para evitar duplicação.' : 'Publicação retomada após reinício do servidor.' });
          }
        }
      });
      data = await readStore();
      secrets = await readSecrets();
    }
    const config = data.config || {};
    if (!secrets.instagramAccessToken || !secrets.instagramUserId) return { connected: false };
    if (!forceId && (config.instagramFeedEnabled !== true || !withinFeedSchedule(config))) return { paused: true };
    const rateLimitUntil = instagramRateLimitUntil(data);
    if (rateLimitUntil > Date.now()) return { rateLimited: true, retryAt: new Date(rateLimitUntil).toISOString() };
    if (!forceId && config.instagramFeedAutoFromWhatsapp === true) {
      let backfilled = 0;
      const preview = { ...data, instagramFeedQueue: structuredClone(data.instagramFeedQueue || []) };
      if (backfillInstagramFeedFromRecentWhatsapp(preview) > 0) {
        await updateStore((fresh) => {
          backfilled = backfillInstagramFeedFromRecentWhatsapp(fresh);
          if (backfilled > 0) appendActivity(fresh, `Instagram Feed: ${backfilled} promoção(ões) recente(s) dos grupos adicionada(s) automaticamente à fila.`, 'success');
        });
        data = await readStore();
      }
    }
    const queue = Array.isArray(data.instagramFeedQueue) ? data.instagramFeedQueue : [];
    const sentLastDay = queue.filter((item) => item.status === 'sent' && Date.now() - new Date(item.publishedAt || 0).getTime() < DAY);
    if (!forceId && sentLastDay.length >= Math.max(1, Number(config.instagramFeedMaxPerDay || 3))) return { limited: true };
    const lastSentAt = sentLastDay.reduce((latest, item) => Math.max(latest, new Date(item.publishedAt || 0).getTime()), 0);
    if (!forceId && lastSentAt && Date.now() - lastSentAt < Math.max(5, Number(config.instagramFeedIntervalMinutes || 120)) * 60_000) return { waiting: true };
    if (!forceId) {
      const latest = latestAutomaticCarousel(data, config);
      if (latest) {
        selected = latest.selected;
        await updateStore((fresh) => {
          const item = (fresh.instagramFeedQueue || []).find((entry) => entry.id === latest.selected.id);
          if (!item) return;
          item.items = latest.stories;
          item.sourceIds = latest.sourceIds;
          item.title = `Carrossel com ${latest.stories.length} promoções recentes`;
          item.caption = sanitizeFeedCaption(config.instagramFeedCaption, latest.stories);
          item.latestSourceAt = latest.stories[0]?.sourcePublishedAt || item.latestSourceAt || item.createdAt;
          for (const entry of fresh.instagramFeedQueue || []) {
            if (latest.consumedIds.includes(entry.id) && entry.status === 'pending') {
              entry.status = 'cancelled';
              entry.error = 'Consolidado no carrossel com as promoções mais recentes dos grupos.';
              entry.retryAt = null;
            }
          }
        });
        data = await readStore();
        selected = (data.instagramFeedQueue || []).find((item) => item.id === latest.selected.id);
      }
    }
    selected ||= forceId
      ? queue.find((item) => item.id === forceId && item.status !== 'sent')
      : queue
        .filter((item) => item.status === 'pending' && (!item.scheduledFor || new Date(item.scheduledFor).getTime() <= Date.now()) && (!item.retryAt || new Date(item.retryAt).getTime() <= Date.now()))
        .sort((a, b) => feedEntryFreshness(b) - feedEntryFreshness(a))[0];
    if (!selected) return { empty: true };
    if (!forceId && selected.postType === 'carousel' && (!Array.isArray(selected.items) || selected.items.length < 2)) {
      return { waitingForCarouselItems: true, currentItems: selected.items?.length || 0 };
    }
    if (!forceId && selected.postType === 'carousel') {
      const sentCarousels = queue.filter((item) => item.status === 'sent' && item.postType === 'carousel');
      const todayCarousels = sentCarousels.filter((item) => Date.now() - new Date(item.publishedAt || 0).getTime() < DAY).length;
      const weekCarousels = sentCarousels.filter((item) => Date.now() - new Date(item.publishedAt || 0).getTime() < 7 * DAY).length;
      const frequency = config.instagramFeedCarouselFrequency === 'weekly' ? 'weekly' : 'daily';
      const limit = frequency === 'weekly'
        ? Math.max(1, Number(config.instagramFeedCarouselsPerWeek || 3))
        : Math.max(1, Number(config.instagramFeedCarouselsPerDay || 1));
      if ((frequency === 'weekly' && weekCarousels >= limit) || (frequency === 'daily' && todayCarousels >= limit)) {
        return { carouselLimitReached: true, frequency, limit };
      }
    }
    if (!Array.isArray(selected.items) || !selected.items.length) throw new Error('A publicação do Feed não possui ofertas válidas.');
    await updateStore((fresh) => {
      const item = (fresh.instagramFeedQueue || []).find((entry) => entry.id === selected.id);
      if (item) { item.status = 'publishing'; item.publishingAt = new Date().toISOString(); item.error = null; }
    });
    const assets = [];
    const assetConfig = { ...config, instagramFeedTemplateMode: selected.templateMode || config.instagramFeedTemplateMode || 'rotating' };
    for (const story of selected.items.slice(0, 10)) assets.push(await generateInstagramFeedAsset(story, assetConfig, selected.themeId, selected.format));
    const canonical = String(config.canonicalUrl || '').replace(/\/$/, '');
    if (!/^https:\/\//i.test(canonical)) throw new Error('Configure o domínio HTTPS do site antes de publicar no Feed.');
    await updateStore((fresh) => {
      const item = (fresh.instagramFeedQueue || []).find((entry) => entry.id === selected.id);
      if (item) item.metaPublishingStartedAt = new Date().toISOString();
    });
    const published = await publishFeedPost(config, secrets, assets.map((asset) => `${canonical}/media/instagram/${asset.fileName}`), sanitizeFeedCaption(selected.caption, selected.items));
    await updateStore((fresh) => {
      const item = (fresh.instagramFeedQueue || []).find((entry) => entry.id === selected.id);
      if (!item) return;
      Object.assign(item, { status: 'sent', publishedAt: new Date().toISOString(), publishingAt: null, metaPublishingStartedAt: null, assetFileNames: assets.map((asset) => asset.fileName), themeId: assets[0]?.themeId || '', containerId: published.containerId, mediaId: published.mediaId, childIds: published.childIds || [], error: null, retryAt: null, instagramRateLimited: false });
      appendActivity(fresh, `Instagram Feed: ${selected.postType === 'carousel' ? 'carrossel' : 'post'} publicado — ${selected.title}.`, 'success');
    });
    return { ok: true, id: selected.id, ...published };
  } catch (error) {
    if (selected) {
      const rateLimited = Boolean(error?.instagramRateLimited) || isInstagramRateLimitError(error);
      await updateStore((fresh) => {
        const item = (fresh.instagramFeedQueue || []).find((entry) => entry.id === selected.id);
        if (!item) return;
        item.attempts = Number(item.attempts || 0) + 1;
        const uncertain = Boolean(item.metaPublishingStartedAt);
        item.status = uncertain ? 'failed' : rateLimited ? 'pending' : item.attempts >= 3 ? 'failed' : 'pending';
        item.instagramRateLimited = rateLimited;
        item.error = uncertain
          ? 'O envio à Meta foi iniciado, mas não houve confirmação. Confira o Instagram antes de tentar novamente para evitar publicação duplicada.'
          : rateLimited ? 'A Meta limitou temporariamente as publicações do Feed. A fila tentará novamente mais tarde.' : String(error.message || error).slice(0, 500);
        item.publishingAt = null;
        const retryDelay = rateLimited ? Math.min(24, 6 * 2 ** Math.min(Math.max(0, item.attempts - 1), 2)) * 60 * 60_000 : Math.min(60, 5 * 2 ** item.attempts) * 60_000;
        item.retryAt = item.status === 'pending' ? new Date(Date.now() + retryDelay).toISOString() : null;
        appendActivity(fresh, `Instagram Feed: falha ao publicar ${selected.title}: ${error.message}`, rateLimited ? 'warning' : 'error');
      });
    }
    throw error;
  } finally {
    feedProcessing = false;
    metaPublishing = false;
  }
}
