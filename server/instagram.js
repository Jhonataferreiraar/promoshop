import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';
import sharp from 'sharp';

import { addLog, createId, readStore, updateStore } from './store.js';
import { readSecrets, updateSecrets } from './secrets.js';
import { selectInstagramTheme } from './instagramThemes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const mediaDir = path.join(dataDir, 'instagram-stories');
const MEDIA_FILE = /^[a-z0-9][a-z0-9._-]{5,100}\.jpe?g$/i;
const DAY = 24 * 60 * 60 * 1000;
let processing = false;

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

async function fetchBuffer(url, maximumBytes = 12 * 1024 * 1024) {
  const safeUrl = validHttps(url);
  if (!safeUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(safeUrl, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`imagem respondeu ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maximumBytes) throw new Error('imagem excede o limite permitido');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) throw new Error('imagem excede o limite permitido');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
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
    await addLog(`Instagram: não foi possível preparar a imagem de ${story.title}: ${error.message}`, 'warning');
  }

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
  const bioLines = splitParagraphLines(svgText(isSite ? (options.siteDescription || defaultBio) : (options.bio || defaultBio)), isSite ? 60 : 34, templateType === 'group' ? 3 : 4);
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
  const bioMarkup = bioLines.map((line, index) => bioLineMarkup(line, bioY + (index * (isSite ? 48 : 52)), bodyFont, isSite ? 28 : 34)).join('');
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

function storySnapshot(data, queueItem) {
  const offer = data.offers.find((entry) => entry.id === queueItem.offerId) || queueItem.offerSnapshot || {};
  const coupon = queueItem.couponSnapshot || {};
  return queueItem.kind === 'coupon'
    ? { kind: 'coupon', sourceId: queueItem.couponId || queueItem.id, title: coupon.title || queueItem.offerTitle, store: coupon.store || queueItem.store, price: 0, originalPrice: 0, discount: coupon.discountType === 'percent' ? coupon.discountValue : 0, image: coupon.image || queueItem.image, link: coupon.shortUrl || coupon.link, audienceCodes: queueItem.targetAudienceCodes || [] }
    : { kind: 'offer', sourceId: queueItem.offerId, title: offer.title || queueItem.offerTitle, store: offer.store || queueItem.store, price: offer.price, originalPrice: offer.originalPrice, discount: offer.discount, image: offer.image || queueItem.image, link: offer.affiliateUrl || queueItem.link, audienceCodes: queueItem.targetAudienceCodes || [] };
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

async function metaJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 400) }; }
    if (!response.ok || body.error) throw new Error(body.error?.message || body.message || `Meta respondeu ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function testInstagramConnection(config, secrets) {
  if (!secrets.instagramAccessToken) throw new Error('Conecte a conta do Instagram primeiro.');
  return metaJson(`${graphUrl(config, '/me')}?fields=user_id,username,name,profile_picture_url&access_token=${encodeURIComponent(secrets.instagramAccessToken)}`);
}

export async function beginInstagramAuthorization(config, secrets) {
  if (!secrets.instagramAppId || !secrets.instagramAppSecret) throw new Error('Informe o ID e a chave secreta do aplicativo da Meta.');
  const redirectUri = validHttps(config.instagramRedirectUri);
  if (!redirectUri) throw new Error('Informe uma URL HTTPS válida para o retorno do Instagram.');
  const state = crypto.randomBytes(24).toString('hex');
  await updateSecrets({ instagramOAuthState: state });
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
  if (!query.code || !query.state || query.state !== secrets.instagramOAuthState) throw new Error('A confirmação do Instagram expirou ou não é válida.');
  const redirectUri = validHttps(config.instagramRedirectUri);
  const form = new URLSearchParams({ client_id: secrets.instagramAppId, client_secret: secrets.instagramAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: String(query.code).replace(/#_$/, '') });
  const shortToken = await metaJson('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const longToken = await metaJson(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(secrets.instagramAppSecret)}&access_token=${encodeURIComponent(shortToken.access_token)}`);
  const accessToken = longToken.access_token || shortToken.access_token;
  const profile = await metaJson(`${graphUrl(config, '/me')}?fields=user_id,username,name,profile_picture_url&access_token=${encodeURIComponent(accessToken)}`);
  await updateSecrets({
    instagramAccessToken: accessToken,
    instagramUserId: String(profile.user_id || shortToken.user_id || profile.id || ''),
    instagramUsername: String(profile.username || ''),
    instagramProfilePictureUrl: String(profile.profile_picture_url || ''),
    instagramTokenExpiresAt: Date.now() + Number(longToken.expires_in || 5184000) * 1000,
    instagramOAuthState: ''
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
  const container = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await metaJson(`${graphUrl(config, `/${container.id}`)}?fields=status_code&access_token=${encodeURIComponent(secrets.instagramAccessToken)}`);
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw new Error(`A Meta não conseguiu preparar o Story (${status.status_code}).`);
    if (attempt === 11) throw new Error('A Meta demorou demais para preparar o Story.');
  }
  const publish = new URLSearchParams({ creation_id: container.id, access_token: secrets.instagramAccessToken });
  const result = await metaJson(graphUrl(config, `/${encodeURIComponent(secrets.instagramUserId)}/media_publish`), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: publish });
  return { containerId: container.id, mediaId: result.id };
}

function withinSchedule(config, date = new Date()) {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const now = `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`;
  const start = /^\d{2}:\d{2}$/.test(config.instagramPublishingStart) ? config.instagramPublishingStart : '08:00';
  const end = /^\d{2}:\d{2}$/.test(config.instagramPublishingEnd) ? config.instagramPublishingEnd : '23:00';
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

export async function processInstagramQueue({ forceId = '' } = {}) {
  if (processing) return { busy: true };
  processing = true;
  let selected = null;
  try {
    let [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const stalePublishing = (data.instagramQueue || []).some((item) => item.status === 'publishing' && Date.now() - new Date(item.publishingAt || item.createdAt || 0).getTime() > 15 * 60_000);
    if (stalePublishing) {
      await updateStore((fresh) => {
        for (const item of fresh.instagramQueue || []) {
          if (item.status === 'publishing' && Date.now() - new Date(item.publishingAt || item.createdAt || 0).getTime() > 15 * 60_000) {
            Object.assign(item, { status: 'pending', publishingAt: null, retryAt: null, error: 'Publicação retomada após reinício do servidor.' });
          }
        }
      });
      data = await readStore();
      secrets = await readSecrets();
    }
    const config = data.config || {};
    if (!secrets.instagramAccessToken || !secrets.instagramUserId) return { connected: false };
    if (!forceId && (config.instagramEnabled !== true || !withinSchedule(config))) return { paused: true };
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
    const asset = await generateInstagramStory(selected, config);
    const canonical = String(config.canonicalUrl || '').replace(/\/$/, '');
    if (!/^https:\/\//i.test(canonical)) throw new Error('Configure o domínio HTTPS do site antes de publicar Stories.');
    const published = await publishAsset(config, secrets, `${canonical}/media/instagram/${asset.fileName}`);
    await updateStore((fresh) => {
      const item = (fresh.instagramQueue || []).find((entry) => entry.id === selected.id);
      if (!item) return;
      Object.assign(item, { status: 'sent', publishedAt: new Date().toISOString(), publishingAt: null, assetFileName: asset.fileName, themeId: asset.themeId, containerId: published.containerId, mediaId: published.mediaId, error: null, retryAt: null });
    });
    await addLog(`Instagram: Story publicado — ${selected.title}.`, 'success');
    return { ok: true, id: selected.id, ...published };
  } catch (error) {
    if (selected) {
      await updateStore((fresh) => {
        const item = (fresh.instagramQueue || []).find((entry) => entry.id === selected.id);
        if (!item) return;
        item.attempts = Number(item.attempts || 0) + 1;
        item.status = item.attempts >= 3 ? 'failed' : 'pending';
        item.error = String(error.message || error).slice(0, 500);
        item.publishingAt = null;
        item.retryAt = item.status === 'pending' ? new Date(Date.now() + Math.min(60, 5 * 2 ** item.attempts) * 60_000).toISOString() : null;
      });
      await addLog(`Instagram: falha ao publicar ${selected.title}: ${error.message}`, 'error');
    }
    throw error;
  } finally {
    processing = false;
  }
}
