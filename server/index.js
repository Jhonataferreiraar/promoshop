import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import QRCode from 'qrcode';

import {
  addLog,
  createId,
  readStore,
  updateStore
} from './store.js';

import {
  createToken,
  requireAdmin,
  requireWorker
} from './auth.js';

import {
  collectAliexpress,
  collectMercadoLivre,
  collectShopee,
  makeQueueItem,
  runCollection,
  searchMercadoLivreProducts,
  searchShopeeProducts
} from './collectors.js';

import {
  readSecrets,
  secretStatus,
  updateSecrets,
  verifyPassword
} from './secrets.js';

import {
  classifyOfferAudience,
  generateFallbackOfferMessage,
  generateOfferMessage,
  getAiAvailability
} from './ai.js';

import {
  beginMercadoLivreAuthorization,
  finishMercadoLivreAuthorization,
  validateMercadoLivreConnection
} from './mercadolivre.js';

import {
  getAudienceCodesForOffer
} from './audienceRouting.js';
import { normalizeSearchText, rankProductSearchResults } from './searchRelevance.js';
import { stripAffiliateDisclosure } from './messageSanitizer.js';
import {
  beginInstagramAuthorization,
  cleanupInstagramAssets,
  enqueueInstagramFromWhatsapp,
  finishInstagramAuthorization,
  generateInstagramShareTemplate,
  generateInstagramStory,
  instagramAssetPath,
  processInstagramQueue,
  refreshInstagramToken,
  testInstagramConnection,
  verifyInstagramSignedRequest
} from './instagram.js';
import { sanitizeInstagramThemes } from './instagramThemes.js';

const app = express();

app.disable('x-powered-by');

const port = Number(
  process.env.PORT || 3001
);

const root = path.resolve(
  path.dirname(
    fileURLToPath(import.meta.url)
  ),
  '..'
);

let indexHtmlPromise = null;

function readIndexHtml() {
  if (!indexHtmlPromise) {
    indexHtmlPromise = fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8')
      .catch((error) => {
        indexHtmlPromise = null;
        throw error;
      });
  }
  return indexHtmlPromise;
}

/*
 * Versão 7:
 *
 * - IA com fallback local.
 * - Roteamento local caso IA falhe.
 * - Rodada por público.
 * - 1 produto diferente para cada público.
 * - Intervalo configurado no painel entre rodadas.
 */
const aiGenerationVersion = 7;

let whatsappProcess = null;
let whatsappRestartTimer = null;
let whatsappStopRequested = false;
let whatsappRestartAttempts = 0;
let collectionInProgress = false;
let lastDeferredCollectionRoundId = '';
const extensionRateLimit = new Map();

function activePublicationRound(data) {
  const round =
    data?.meta
      ?.publicationRound;

  return round &&
    Array.isArray(
      round.pendingAudienceCodes
    ) &&
    round.pendingAudienceCodes.length
      ? round
      : null;
}

function isPublishingWindow(config = {}, now = new Date()) {
  const hourMinute = now.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const publishingStart = String(config.publishingStart || config.quietEnd || '08:00');
  const publishingEnd = String(config.publishingEnd || config.quietStart || '23:00');
  if (publishingStart === publishingEnd) return true;
  return publishingStart < publishingEnd
    ? hourMinute >= publishingStart && hourMinute < publishingEnd
    : hourMinute >= publishingStart || hourMinute < publishingEnd;
}

async function rememberCollectionRequest() {
  await updateStore(
    (data) => {
      data.meta =
        data.meta || {};

      data.meta
        .collectionRequestedAt =
        data.meta
          .collectionRequestedAt ||
        new Date()
          .toISOString();
    }
  );
}

async function runCollectionWhenIdle({
  requestedByAdmin = false,
  allowOutsidePublishingWindow = false
} = {}) {
  if (collectionInProgress) {
    if (requestedByAdmin) {
      await rememberCollectionRequest();
    }

    return {
      imported: 0,
      queued: true,
      reason: 'collection-in-progress'
    };
  }

  /*
   * A trava é ligada antes da primeira leitura assíncrona.
   * Assim, o worker não consegue iniciar uma nova rodada no
   * pequeno intervalo entre a verificação e o começo da coleta.
   */
  collectionInProgress = true;

  try {
    const data =
      await readStore();

    const round =
      activePublicationRound(
        data
      );

    const manualOutsideSchedule = requestedByAdmin
      && allowOutsidePublishingWindow
      && !isPublishingWindow(data.config || {});

    if (round && !manualOutsideSchedule) {
      if (requestedByAdmin) {
        await rememberCollectionRequest();
      }

      if (
        lastDeferredCollectionRoundId !==
        round.id
      ) {
        lastDeferredCollectionRoundId =
          round.id;

        await addLog(
          `Coleta aguardando a rodada ${round.id} finalizar.`,
          'info'
        );
      }

      return {
        imported: 0,
        queued: true,
        reason: 'publication-round'
      };
    }

    if (round && manualOutsideSchedule) {
      await addLog('Coleta manual iniciada fora do horário de publicação; a rodada existente foi mantida.', 'info');
    }

    const result =
      await runCollection();

    await updateStore(
      (freshData) => {
        freshData.meta =
          freshData.meta || {};

        delete freshData.meta
          .collectionRequestedAt;
      }
    );

    lastDeferredCollectionRoundId =
      '';

    return {
      ...result,
      queued: false
    };
  } finally {
    collectionInProgress = false;
  }
}

const loginAttempts = new Map();

const loginWindowMs =
  15 * 60 * 1000;

const loginMaxAttempts = 5;

const assistantAttempts = new Map();

const assistantWindowMs =
  10 * 60 * 1000;

const assistantMaxAttempts = 30;

const contactAttempts = new Map();

const contactWindowMs =
  15 * 60 * 1000;

const contactMaxAttempts = 5;

const analyticsAttempts = new Map();
const analyticsWindowMs = 10 * 60 * 1000;
const analyticsMaxAttempts = 180;

app.set('trust proxy', 1);

/*
 * ==========================================================
 * SEGURANÇA / LIMITES
 * ==========================================================
 */

function loginAttemptState(ip) {
  const now = Date.now();

  for (const [key, value] of loginAttempts) {
    if (
      value.resetAt <= now &&
      value.blockedUntil <= now
    ) {
      loginAttempts.delete(key);
    }
  }

  return (
    loginAttempts.get(ip) || {
      count: 0,
      resetAt:
        now + loginWindowMs,
      blockedUntil: 0
    }
  );
}

function registerFailedLogin(ip) {
  const state =
    loginAttemptState(ip);

  state.count += 1;

  if (
    state.count >=
    loginMaxAttempts
  ) {
    state.blockedUntil =
      Date.now() +
      loginWindowMs;
  }

  loginAttempts.set(
    ip,
    state
  );

  return state;
}

function checkAssistantLimit(ip) {
  const now = Date.now();

  const current =
    assistantAttempts.get(ip) || {
      count: 0,
      resetAt:
        now + assistantWindowMs
    };

  if (
    current.resetAt <= now
  ) {
    current.count = 0;

    current.resetAt =
      now +
      assistantWindowMs;
  }

  if (
    current.count >=
    assistantMaxAttempts
  ) {
    return {
      allowed: false,

      retryAfter:
        Math.max(
          1,
          Math.ceil(
            (
              current.resetAt -
              now
            ) /
            1000
          )
        )
    };
  }

  current.count += 1;

  assistantAttempts.set(
    ip,
    current
  );

  return {
    allowed: true,

    remaining:
      Math.max(
        0,
        assistantMaxAttempts -
        current.count
      )
  };
}

function checkContactLimit(ip) {
  const now = Date.now();
  const current = contactAttempts.get(ip) || {
    count: 0,
    resetAt: now + contactWindowMs
  };

  if (current.resetAt <= now) {
    current.count = 0;
    current.resetAt = now + contactWindowMs;
  }

  if (current.count >= contactMaxAttempts) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    };
  }

  current.count += 1;
  contactAttempts.set(ip, current);

  return {
    allowed: true,
    remaining: Math.max(0, contactMaxAttempts - current.count)
  };
}

function checkAnalyticsLimit(ip) {
  const now = Date.now();
  const current = analyticsAttempts.get(ip) || { count: 0, resetAt: now + analyticsWindowMs };
  if (current.resetAt <= now) {
    current.count = 0;
    current.resetAt = now + analyticsWindowMs;
  }
  if (current.count >= analyticsMaxAttempts) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  analyticsAttempts.set(ip, current);
  return { allowed: true };
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function contactMessageHtml(message) {
  return escapeHtml(message).replace(/\r?\n/g, '<br>');
}

function buildContactEmailHtml({ name, email, subject, message }) {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeSubject = escapeHtml(subject);
  const safeMessage = contactMessageHtml(message);
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mensagem recebida pelo PromoShop</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { width: 100% !important; }
        .email-pad { padding: 24px 18px !important; }
        .email-title { font-size: 24px !important; line-height: 1.2 !important; }
        .email-meta { display: block !important; }
        .email-meta-label { display: block !important; width: auto !important; padding-bottom: 4px !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; width:100%; background:#f3f6fb; color:#1d2939; font-family:Arial,Helvetica,sans-serif; -webkit-text-size-adjust:100%;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; background:#f3f6fb;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" class="email-shell" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:600px; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid #e4e7ec; border-radius:18px; background:#ffffff;">
            <tr>
              <td style="padding:26px 30px; background:#0b1f3a; color:#ffffff;">
                <div style="font-size:14px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#9fc2ff;">PromoShop</div>
                <div class="email-title" style="margin-top:10px; font-size:28px; line-height:1.25; font-weight:800;">Nova mensagem recebida</div>
                <div style="margin-top:8px; color:#d7e5ff; font-size:14px; line-height:1.5;">Uma pessoa entrou em contato pelo seu site.</div>
              </td>
            </tr>
            <tr>
              <td class="email-pad" style="padding:30px;">
                <p style="margin:0 0 20px; color:#344054; font-size:16px; line-height:1.6;">Olá, PromoShop! Você recebeu uma nova mensagem:</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; border:1px solid #eaecf0; border-radius:12px; overflow:hidden;">
                  <tr class="email-meta">
                    <td class="email-meta-label" width="120" style="width:120px; padding:14px 16px; border-bottom:1px solid #eaecf0; color:#667085; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; vertical-align:top;">Nome</td>
                    <td style="padding:14px 16px; border-bottom:1px solid #eaecf0; color:#101828; font-size:15px; line-height:1.5; word-break:break-word;">${safeName}</td>
                  </tr>
                  <tr class="email-meta">
                    <td class="email-meta-label" width="120" style="width:120px; padding:14px 16px; border-bottom:1px solid #eaecf0; color:#667085; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; vertical-align:top;">E-mail</td>
                    <td style="padding:14px 16px; border-bottom:1px solid #eaecf0; color:#101828; font-size:15px; line-height:1.5; word-break:break-word;"><a href="mailto:${safeEmail}" style="color:#1269f3; text-decoration:none;">${safeEmail}</a></td>
                  </tr>
                  <tr class="email-meta">
                    <td class="email-meta-label" width="120" style="width:120px; padding:14px 16px; border-bottom:1px solid #eaecf0; color:#667085; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; vertical-align:top;">Assunto</td>
                    <td style="padding:14px 16px; border-bottom:1px solid #eaecf0; color:#101828; font-size:15px; line-height:1.5; word-break:break-word;">${safeSubject}</td>
                  </tr>
                  <tr>
                    <td colspan="2" style="padding:16px; color:#667085; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;">Mensagem</td>
                  </tr>
                  <tr>
                    <td colspan="2" style="padding:0 16px 18px; color:#344054; font-size:15px; line-height:1.7; word-break:break-word; overflow-wrap:anywhere;">${safeMessage}</td>
                  </tr>
                </table>
                <div style="margin-top:24px; padding:16px 18px; border-left:4px solid #1269f3; border-radius:8px; background:#eff6ff; color:#344054; font-size:13px; line-height:1.55;">Para responder, use o botão de resposta do seu e-mail. A resposta será enviada diretamente para ${safeName}.</div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px; border-top:1px solid #eaecf0; color:#98a2b3; font-size:12px; line-height:1.5; text-align:center;"><div>Mensagem enviada pelo formulário de contato do PromoShop.</div><div style="margin-top:6px;">© ${year} PromoShop · <a href="https://promoshop.jhonatafaraujo.com.br" style="color:#667085; text-decoration:none;">promoshop.jhonatafaraujo.com.br</a></div></td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildContactReplyHtml({ name, message }) {
  const safeName = escapeHtml(name);
  const safeMessage = contactMessageHtml(message);
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Resposta do PromoShop</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { width: 100% !important; }
        .email-pad { padding: 24px 18px !important; }
        .email-title { font-size: 24px !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; width:100%; background:#f3f6fb; color:#1d2939; font-family:Arial,Helvetica,sans-serif; -webkit-text-size-adjust:100%;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; background:#f3f6fb;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" class="email-shell" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:600px; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid #e4e7ec; border-radius:18px; background:#ffffff;">
            <tr>
              <td style="padding:26px 30px; background:#0b1f3a; color:#ffffff;">
                <div style="font-size:14px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#9fc2ff;">PromoShop</div>
                <div class="email-title" style="margin-top:10px; font-size:28px; line-height:1.25; font-weight:800;">Resposta da nossa equipe</div>
              </td>
            </tr>
            <tr>
              <td class="email-pad" style="padding:30px;">
                <p style="margin:0 0 18px; color:#344054; font-size:16px; line-height:1.6;">Olá, ${safeName}!</p>
                <div style="padding:20px; border:1px solid #eaecf0; border-radius:12px; color:#344054; font-size:15px; line-height:1.7; word-break:break-word; overflow-wrap:anywhere;">${safeMessage}</div>
                <p style="margin:22px 0 0; color:#667085; font-size:13px; line-height:1.6;">Obrigado por entrar em contato com o PromoShop.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px; border-top:1px solid #eaecf0; color:#98a2b3; font-size:12px; line-height:1.5; text-align:center;"><div>Esta mensagem foi enviada pelo painel de atendimento do PromoShop.</div><div style="margin-top:6px;">© ${year} PromoShop · <a href="https://promoshop.jhonatafaraujo.com.br" style="color:#667085; text-decoration:none;">promoshop.jhonatafaraujo.com.br</a></div></td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function normalizeInboundDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

function isValidInboundDomain(value) {
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  return `${protocol}://${req.get('host')}`;
}

function publicBaseUrl(req) {
  if (req?.get) return requestBaseUrl(req).replace(/\/$/, '');
  const configured = String(
    process.env.PUBLIC_URL || process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || ''
  ).split(',')[0].trim().replace(/\/$/, '');
  return configured || `http://localhost:${port}`;
}

function couponShortCode(coupon) {
  const stored = String(coupon?.shortCode || '').trim().toLowerCase();
  if (stored) return stored;
  const fallback = String(coupon?.id || '')
    .replace(/^coupon_/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(-12)
    .toLowerCase();
  return fallback || 'coupon';
}

function createCouponShortCode(coupons = []) {
  let code = '';
  do {
    code = crypto.randomBytes(4).toString('hex');
  } while (coupons.some((coupon) => couponShortCode(coupon) === code));
  return code;
}

function couponShortUrl(coupon, req) {
  return `${publicBaseUrl(req)}/c/${encodeURIComponent(couponShortCode(coupon))}`;
}

function inboundWebhookUrl(req, token) {
  return `${requestBaseUrl(req)}/api/webhooks/brevo/inbound?token=${encodeURIComponent(token)}`;
}

function inboundReplyAddress(config, inboxId) {
  if (config.inboxInboundEnabled !== true) return '';
  const domain = normalizeInboundDomain(config.inboxInboundDomain);
  if (!isValidInboundDomain(domain)) return '';
  const localPart = `ticket-${String(inboxId || '').replace(/[^a-z0-9-]/gi, '-').slice(-72)}`;
  return `${localPart}@${domain}`;
}

function secretsMatch(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function mailboxAddress(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  return String(value?.Address || value?.address || '').trim().toLowerCase();
}

function mailboxName(value) {
  if (typeof value === 'string') return '';
  return String(value?.Name || value?.name || '').trim();
}

const analyticsSessionWindowMs = 30 * 60 * 1000;
const privacyPolicyVersion = '2026-08-23-v5';

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function sanitizeAudienceKeywordList(value) {
  const words = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/);
  const result = [];
  const seen = new Set();
  for (const word of words) {
    const clean = String(word || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const key = clean.toLocaleLowerCase('pt-BR');
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= 200) break;
  }
  return result;
}

function sanitizeWhatsappAudiences(value) {
  const audiences = Array.isArray(value) ? value : [];
  const seenCodes = new Set();
  return audiences.slice(0, 50).map((audience) => {
    const code = String(audience?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!code || seenCodes.has(code)) return null;
    seenCodes.add(code);
    const profile = String(audience?.profile || 'general').toLowerCase() === 'female' ? 'female' : 'general';
    return {
      code,
      name: String(audience?.name || '').trim().slice(0, 100),
      whatsappLink: /^https:\/\//i.test(String(audience?.whatsappLink || '').trim()) ? String(audience.whatsappLink).trim().slice(0, 1000) : '',
      enabled: audience?.enabled !== false,
      general: code === 'G01',
      deals: code === 'G10',
      profile,
      minDiscount: boundedNumber(audience?.minDiscount, code === 'G10' ? 40 : 0, 0, 99),
      keywords: sanitizeAudienceKeywordList(audience?.keywords),
      blockedKeywords: sanitizeAudienceKeywordList(audience?.blockedKeywords)
    };
  }).filter(Boolean);
}

function normalizeAnalyticsId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,128}$/.test(id) ? id : '';
}

function pruneInboxEntries(data, nowMs = Date.now()) {
  const retentionMs = boundedNumber(data.config?.contactRetentionMonths, 12, 1, 60) * 30.4375 * 24 * 60 * 60 * 1000;
  data.inbox = (Array.isArray(data.inbox) ? data.inbox : []).filter((entry) => {
    const activityDates = [entry?.createdAt, entry?.repliedAt, entry?.lastInboundAt, ...(entry?.replies || []).map((reply) => reply?.createdAt)]
      .map((value) => new Date(value || 0).getTime())
      .filter(Number.isFinite);
    const lastActivityAt = activityDates.length ? Math.max(...activityDates) : 0;
    return lastActivityAt > 0 && nowMs - lastActivityAt <= retentionMs;
  }).slice(0, 500);
}

function normalizedTerms(value) {
  return String(value || '')
    .split(',')
    .map((term) => term.trim().toLocaleLowerCase('pt-BR'))
    .filter(Boolean)
    .slice(0, 100);
}

function offerQuality(offer, config = {}) {
  const title = String(offer?.title || '').trim();
  const price = Number(offer?.price || 0);
  const originalPrice = Number(offer?.originalPrice || 0);
  const image = String(offer?.image || '').trim();
  const link = String(offer?.affiliateUrl || '').trim();
  const category = String(offer?.category || '').trim();
  const blocked = normalizedTerms(config.qualityBlockedTerms);
  const maxTitleLength = boundedNumber(config.qualityMaxTitleLength, 180, 40, 500);
  const issues = [];
  let score = 0;

  if (title.length >= 8 && title.length <= maxTitleLength) score += 20;
  else issues.push(title.length > maxTitleLength ? 'Título muito longo' : 'Título incompleto');
  if (image && /^https:\/\//i.test(image)) score += 15;
  else if (config.qualityRequireImage !== false) issues.push('Imagem ausente ou insegura');
  else score += 15;
  if (link && /^https:\/\//i.test(link)) score += 20;
  else if (config.qualityRequireHttpsLink !== false) issues.push('Link HTTPS ausente');
  else if (link) score += 20;
  if (price > 0) score += 20;
  else issues.push('Preço inválido');
  if (originalPrice > price && price > 0) score += 10;
  if (category) score += 10;
  if (offer?.store) score += 5;
  if (blocked.some((term) => title.toLocaleLowerCase('pt-BR').includes(term))) {
    score = Math.max(0, score - 45);
    issues.push('Contém termo bloqueado');
  }
  if (offer?.linkStatus === 'broken') {
    score = Math.max(0, score - 35);
    issues.push('Link marcado com erro');
  }

  return { score: Math.min(100, score), issues };
}

function offerIsFresh(offer, config, nowMs = Date.now()) {
  if (config.staleOffersHidden === false) return true;
  const maxAgeDays = boundedNumber(config.publicOfferMaxAgeDays, 45, 1, 365);
  const updatedAt = new Date(offer?.updatedAt || offer?.createdAt || 0).getTime();
  return Number.isFinite(updatedAt) && updatedAt > 0 && nowMs - updatedAt <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function publicOfferAllowed(offer, config, nowMs = Date.now()) {
  if (offer?.status !== 'active' || !offerIsFresh(offer, config, nowMs)) return false;
  if (offer?.qualityOverride === true || config.qualityFilterEnabled === false) return true;
  const quality = offerQuality(offer, config);
  return quality.score >= boundedNumber(config.qualityMinimumScore, 55, 0, 100);
}

function catalogSlug(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

function offerPublicSlug(offer) {
  return `${catalogSlug(offer?.title) || 'oferta'}-${String(offer?.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase()}`;
}

const productStopWords = new Set(['com','para','por','de','da','do','das','dos','em','e','ou','um','uma','kit','novo','nova','original','produto']);
function productFingerprint(offer) {
  return String(offer?.title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !productStopWords.has(word)).slice(0, 7).sort().join('-');
}

function offerDiscount(offer) {
  const price = Number(offer?.price || 0);
  const original = Number(offer?.originalPrice || 0);
  return original > price && price > 0 ? Math.round((1 - price / original) * 100) : 0;
}

function smartOfferScore(offer, config, analytics = {}, nowMs = Date.now()) {
  const ageDays = Math.max(0, (nowMs - new Date(offer?.updatedAt || offer?.createdAt || 0).getTime()) / 86400000);
  const freshness = Math.max(0, 100 - ageDays * 3);
  const quality = offerQuality(offer, config).score;
  const clicks = Number(analytics?.clicksByTarget?.[`offer:${offer.id}`]?.count || 0);
  const clickScore = Math.min(100, Math.log2(clicks + 1) * 18);
  const weights = {
    discount: boundedNumber(config.rankingDiscountWeight, 35, 0, 100),
    freshness: boundedNumber(config.rankingFreshnessWeight, 25, 0, 100),
    quality: boundedNumber(config.rankingQualityWeight, 25, 0, 100),
    clicks: boundedNumber(config.rankingClicksWeight, 15, 0, 100)
  };
  const total = Math.max(1, Object.values(weights).reduce((sum, value) => sum + value, 0));
  return Math.round((Math.min(100, offerDiscount(offer)) * weights.discount + freshness * weights.freshness + quality * weights.quality + clickScore * weights.clicks) / total);
}

function diversifyOffers(offers) {
  const remaining = [...offers];
  const result = [];
  while (remaining.length) {
    const previousStore = result.at(-1)?.store;
    const index = remaining.findIndex((offer) => offer.store !== previousStore);
    result.push(remaining.splice(index >= 0 ? index : 0, 1)[0]);
  }
  return result;
}

const assistantIgnoredWords = new Set([
  'a', 'agora', 'algo', 'algum', 'alguma', 'as', 'ate', 'barato', 'barata',
  'busco', 'com', 'comprar', 'da', 'das', 'de', 'do', 'dos', 'e', 'em',
  'encontrar', 'escola', 'estudar', 'estudo', 'estudos', 'eu', 'faculdade',
  'gostaria', 'me', 'mais', 'maximo', 'menos', 'melhor',
  'mostra', 'mostrar', 'na', 'nas', 'no', 'nos', 'o', 'oferta', 'ofertas',
  'opcao', 'opcoes', 'ou', 'para', 'pela', 'pelo', 'por', 'preciso', 'procuro',
  'produto', 'produtos', 'promocao', 'promocoes', 'quero', 'r', 'reais', 'sem',
  'ser', 'trabalhar', 'trabalho', 'uma', 'um', 'usar', 'uso', 'valor', 'ver'
]);
const assistantKnownProductWords = new Set([
  'airfryer', 'aspirador', 'celular', 'earphone', 'fone', 'fritadeira', 'headphone',
  'headset', 'iphone', 'laptop', 'notebook', 'relogio', 'roboaspirador', 'skincare',
  'smartphone', 'smarttv', 'smartwatch', 'televisao', 'tv', 'ultrabook'
]);

function sanitizeAssistantHistory(value) {
  return (Array.isArray(value) ? value : []).slice(-10).map((entry) => ({
    role: entry?.role === 'assistant' ? 'assistant' : 'user',
    content: String(entry?.content || '').trim().slice(0, 600)
  })).filter((entry) => entry.content);
}

function assistantConversationReply(value) {
  const message = normalizeSearchText(value);
  if (!message) return '';
  if (/^(?:nao )?(?:obrigad[oa]|muito obrigad[oa]|valeu|agradeco|brigad[oa])$/.test(message)) {
    return 'Por nada! 😊 Quando quiser procurar outro produto ou descobrir um grupo de ofertas, é só me chamar.';
  }
  if (/^(?:oi|ola|opa|bom dia|boa tarde|boa noite|e ai)$/.test(message)) {
    return 'Olá! 👋 Que bom ter você aqui. O que você está procurando hoje? Posso ajudar com produtos, preços e grupos de ofertas.';
  }
  if (/^(?:tchau|ate mais|ate logo|falou|fui)$/.test(message)) {
    return 'Até mais! 👋 Volte quando quiser encontrar uma oferta ou um grupo da PromoShop.';
  }
  if (/^(?:tudo bem|como vai|como voce esta)$/.test(message)) {
    return 'Tudo bem por aqui! 😊 E com você? Quando quiser, me diga qual produto ou tipo de oferta está procurando.';
  }
  if (/^(?:ok|okay|beleza|entendi|certo|perfeito|show)$/.test(message)) {
    return 'Perfeito! Se quiser continuar, pode pedir outro produto, mudar o orçamento ou escolher um tipo de grupo.';
  }
  return '';
}

function parseAssistantAmount(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 0;
  const multiplier = /\bmil\b/.test(raw) ? 1000 : 1;
  const cleaned = raw.replace(/\bmil\b/g, '').replace(/\s+/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const number = Number(cleaned);
  return Number.isFinite(number) ? number * multiplier : 0;
}

function assistantBudgetFromText(value) {
  const text = String(value || '');
  const normalized = normalizeSearchText(text);
  if (/\bsem limite\b|\bqualquer preco\b|\btanto faz o preco\b/.test(normalized)) {
    return { specified: true, maximum: Number.POSITIVE_INFINITY, preferCheapest: false };
  }

  const patterns = [
    /(?:at[eé]|m[aá]ximo|no m[aá]ximo|por menos de|abaixo de)\s*(?:r\$\s*)?([\d.]+(?:,\d{1,2})?\s*(?:mil)?)/i,
    /(?:r\$\s*)?([\d.]+(?:,\d{1,2})?\s*(?:mil)?)\s*(?:reais)?\s*(?:ou menos|no m[aá]ximo)/i,
    /(?:entre|de)\s*(?:r\$\s*)?[\d.]+(?:,\d{1,2})?\s*(?:e|a|at[eé])\s*(?:r\$\s*)?([\d.]+(?:,\d{1,2})?\s*(?:mil)?)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const maximum = parseAssistantAmount(match?.[1]);
    if (maximum > 0) return { specified: true, maximum, preferCheapest: false };
  }

  const shortAmount = text.match(/^\s*(?:r\$\s*)?([\d.]+(?:,\d{1,2})?\s*(?:mil)?)\s*(?:reais)?\s*$/i);
  const shortMaximum = parseAssistantAmount(shortAmount?.[1]);
  if (shortMaximum > 0) return { specified: true, maximum: shortMaximum, preferCheapest: false };

  const preferCheapest = /\bbarat[oa]s?\b|\bmais em conta\b|\bmenor preco\b/.test(normalized);
  return { specified: preferCheapest, maximum: Number.POSITIVE_INFINITY, preferCheapest };
}

function assistantCatalogQuery(value, offers) {
  const catalogTokens = new Set(
    (Array.isArray(offers) ? offers : []).flatMap((offer) =>
      normalizeSearchText(`${offer.title || ''} ${offer.category || ''}`).split(/\s+/)
    ).filter((token) => token.length >= 2)
  );
  const result = [];
  const seen = new Set();
  for (const token of normalizeSearchText(value).split(/\s+/)) {
    if (token.length < 2 || /^\d+$/.test(token) || assistantIgnoredWords.has(token) || (!catalogTokens.has(token) && !assistantKnownProductWords.has(token)) || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= 8) break;
  }
  return result.join(' ');
}

function assistantStoreFromText(value) {
  const text = normalizeSearchText(value);
  if (/\bshopee\b/.test(text)) return 'shopee';
  if (/\baliexpress\b|\bali express\b/.test(text)) return 'aliexpress';
  if (/\bmercado livre\b|\bml\b/.test(text)) return 'mercado livre';
  if (/\bmagalu\b|\bmagazine luiza\b/.test(text)) return 'magalu';
  return '';
}

function assistantAudienceRecommendations(interestText, products, audiences) {
  const codes = [];
  const normalizedInterest = normalizeSearchText(interestText);
  const interestMatches = (audiences || []).filter((audience) =>
    audience && audience.enabled !== false && !['G01', 'G10'].includes(String(audience.code || '').toUpperCase())
  ).map((audience) => {
    const keywordScore = (Array.isArray(audience.keywords) ? audience.keywords : []).reduce((total, keyword) => {
      const normalizedKeyword = normalizeSearchText(keyword);
      return total + (normalizedKeyword && (` ${normalizedInterest} `).includes(` ${normalizedKeyword} `) ? Math.max(1, normalizedKeyword.split(' ').length) : 0);
    }, 0);
    const nameScore = normalizeSearchText(audience.name).split(/\s+/).filter((word) => word.length >= 3)
      .reduce((total, word) => total + ((` ${normalizedInterest} `).includes(` ${word} `) ? 2 : 0), 0);
    return { code: String(audience.code || '').toUpperCase(), score: keywordScore + nameScore };
  }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score);

  for (const match of interestMatches) if (!codes.includes(match.code)) codes.push(match.code);
  for (const product of products) {
    const productCodes = Array.isArray(product.targetAudienceCodes) && product.targetAudienceCodes.length
      ? product.targetAudienceCodes
      : getAudienceCodesForOffer(product, audiences);
    for (const code of productCodes) if (!codes.includes(code)) codes.push(code);
  }
  if (!codes.length && normalizedInterest) {
    codes.push(...getAudienceCodesForOffer({ title: interestText, category: interestText, price: 1, originalPrice: 1 }, audiences));
  }
  if (/\bimperdivel\b|\bgrande desconto\b|\bmaior desconto\b/.test(normalizedInterest) && !codes.includes('G10')) {
    codes.push('G10');
  }
  if (/\bgeral\b|\btodos os produtos\b|\bqualquer oferta\b/.test(normalizedInterest) && !codes.includes('G01')) {
    codes.push('G01');
  }
  const thematic = codes.filter((code) => !['G01', 'G10'].includes(String(code).toUpperCase()));
  const selectedCodes = [...thematic, ...codes.filter((code) => !thematic.includes(code))].slice(0, 3);
  return selectedCodes.map((code) => (audiences || []).find((audience) =>
    String(audience.code || '').toUpperCase() === String(code || '').toUpperCase()
  )).filter((audience) => audience && audience.enabled !== false).map((audience) => ({
    code: String(audience.code || ''),
    name: String(audience.name || ''),
    whatsappLink: String(audience.whatsappLink || '')
  }));
}

function assistantProducts(query, offers, config, analytics, { maximum, preferCheapest, store, seenProductIds }) {
  const normalizedStore = normalizeSearchText(store);
  let ranked = rankProductSearchResults(query, offers, { strict: false, limitPerStore: 50 })
    .filter((offer) => !normalizedStore || normalizeSearchText(offer.store).includes(normalizedStore))
    .filter((offer) => !Number.isFinite(maximum) || Number(offer.price || 0) <= maximum)
    .filter((offer) => !seenProductIds.has(String(offer.id || '')));

  ranked.sort((a, b) => preferCheapest
    ? Number(a.price || 0) - Number(b.price || 0)
    : (Number(b.relevance?.score || 0) * 2 + smartOfferScore(b, config, analytics)) - (Number(a.relevance?.score || 0) * 2 + smartOfferScore(a, config, analytics))
  );

  const selected = [];
  const storeCounts = new Map();
  for (const offer of ranked) {
    const storeKey = normalizeSearchText(offer.store) || 'loja';
    if ((storeCounts.get(storeKey) || 0) >= 2) continue;
    selected.push(offer);
    storeCounts.set(storeKey, (storeCounts.get(storeKey) || 0) + 1);
    if (selected.length >= 4) break;
  }
  return selected;
}

function analyticsDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function analyticsDaySummary(day) {
  const visitors = day?.visitors && typeof day.visitors === 'object'
    ? day.visitors
    : {};

  return {
    date: String(day?.date || ''),
    pageViews: Number(day?.pageViews || 0),
    sessions: Number(day?.sessions || 0),
    uniqueVisitors: Object.keys(visitors).length,
    clicks: Number(day?.clicks || 0),
    uniqueClickers: Object.keys(day?.clickers || {}).length
  };
}

function summarizeAnalytics(analytics = {}) {
  const visitors = analytics.visitors && typeof analytics.visitors === 'object'
    ? analytics.visitors
    : {};
  const daily = analytics.daily && typeof analytics.daily === 'object'
    ? analytics.daily
    : {};
  const todayKey = analyticsDay();
  const dates = Object.keys(daily).sort();
  const mapDates = (amount) => dates.slice(-amount).map((date) => analyticsDaySummary({ ...(daily[date] || {}), date }));

  return {
    totalPageViews: Number(analytics.totalPageViews || 0),
    totalSessions: Number(analytics.totalSessions || 0),
    totalVisitors: Number(analytics.totalVisitors || Object.keys(visitors).length),
    totalClicks: Number(analytics.totalClicks || 0),
    clicksByType: analytics.clicksByType || {},
    clicksByStore: analytics.clicksByStore || {},
    topTargets: Object.values(analytics.clicksByTarget || {})
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
      .slice(0, 12),
    today: analyticsDaySummary({
      ...(daily[todayKey] || {}),
      date: todayKey
    }),
    last14Days: mapDates(14),
    last30Days: mapDates(30),
    last90Days: mapDates(90)
  };
}

function summarizeSystemHealth(data = {}) {
  const config = data.config || {};
  const nowMs = Date.now();
  const whatsappLastSeen = new Date(data.meta?.whatsapp?.lastSeenAt || 0).getTime();
  const collectionLastSeen = new Date(data.meta?.lastCollectionAt || 0).getTime();
  const failedQueue = (data.queue || []).filter((item) => item.status === 'failed').length;
  const activeOffers = (data.offers || []).filter((offer) => offer.status === 'active');
  const staleOffers = activeOffers.filter((offer) => !offerIsFresh(offer, config, nowMs)).length;
  const lowQualityOffers = activeOffers.filter((offer) => offerQuality(offer, config).score < boundedNumber(config.qualityMinimumScore, 55, 0, 100)).length;
  const checks = [
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      ok: data.meta?.whatsapp?.status === 'connected' && Number.isFinite(whatsappLastSeen) && nowMs - whatsappLastSeen <= boundedNumber(config.monitoringWhatsappMinutes, 5, 1, 120) * 60_000,
      detail: data.meta?.whatsapp?.status === 'connected' ? 'Conectado e respondendo' : 'Publicador desconectado ou sem resposta'
    },
    {
      id: 'collection',
      label: 'Coleta automática',
      ok: !config.enableMercadoLivre && !config.enableShopee && !config.enableAliexpress && !config.enableMagalu
        ? true
        : Number.isFinite(collectionLastSeen) && nowMs - collectionLastSeen <= boundedNumber(config.monitoringCollectionHours, 6, 1, 168) * 60 * 60_000,
      detail: collectionLastSeen ? `Última coleta em ${new Date(collectionLastSeen).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : 'Nenhuma coleta registrada'
    },
    {
      id: 'queue',
      label: 'Fila de publicação',
      ok: failedQueue < boundedNumber(config.monitoringFailedQueueLimit, 10, 1, 500),
      detail: `${failedQueue} publicação(ões) com falha`
    },
    {
      id: 'offers',
      label: 'Qualidade das ofertas',
      ok: lowQualityOffers === 0 && staleOffers === 0,
      detail: `${lowQualityOffers} abaixo da nota e ${staleOffers} antiga(s)`
    }
  ];

  return {
    status: checks.every((check) => check.ok) ? 'healthy' : checks.some((check) => check.ok) ? 'attention' : 'critical',
    checkedAt: new Date().toISOString(),
    checks,
    totals: { failedQueue, activeOffers: activeOffers.length, staleOffers, lowQualityOffers }
  };
}

const affiliateHostSuffixes = [
  'mercadolivre.com.br',
  'mercadolivre.com',
  'meli.la',
  'shopee.com.br',
  'shopee.com',
  's.shopee.com.br',
  'aliexpress.com',
  'a.aliexpress.com',
  'magazinevoce.com.br',
  'magazineluiza.com.br'
];

function safeAffiliateDestination(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!affiliateHostSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function inspectAffiliateLink(value) {
  const parsed = safeAffiliateDestination(value);
  if (!parsed) return { status: 'unchecked', detail: 'Domínio não incluído na verificação segura' };
  try {
    const response = await fetch(parsed, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
      headers: { 'user-agent': 'PromoShop-LinkMonitor/1.0' }
    });
    if ((response.status >= 200 && response.status < 400) || [401, 403, 405, 429].includes(response.status)) {
      return { status: 'ok', detail: `HTTP ${response.status}` };
    }
    if ([404, 410].includes(response.status)) return { status: 'broken', detail: `HTTP ${response.status}` };
    return { status: 'unknown', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { status: 'unknown', detail: String(error?.message || 'Falha temporária').slice(0, 160) };
  }
}

async function runOfferLinkChecks() {
  const data = await readStore();
  const limit = boundedNumber(data.config?.linkCheckBatchSize, 20, 1, 50);
  const candidates = (data.offers || [])
    .filter((offer) => offer.status === 'active' && offer.affiliateUrl)
    .sort((left, right) => new Date(left.lastLinkCheckAt || 0) - new Date(right.lastLinkCheckAt || 0))
    .slice(0, limit);
  const results = [];

  for (const offer of candidates) {
    const result = await inspectAffiliateLink(offer.affiliateUrl);
    results.push({ id: offer.id, title: offer.title, ...result });
  }

  await updateStore((store) => {
    for (const result of results) {
      const offer = store.offers.find((entry) => entry.id === result.id);
      if (!offer) continue;
      offer.linkStatus = result.status;
      offer.linkCheckDetail = result.detail;
      offer.lastLinkCheckAt = new Date().toISOString();
      if (result.status === 'broken' && store.config?.linkCheckAutoPause === true) {
        offer.status = 'inactive';
        offer.pausedReason = 'Link confirmado como indisponível pela verificação automática.';
      }
    }
  });

  const broken = results.filter((result) => result.status === 'broken').length;
  const ok = results.filter((result) => result.status === 'ok').length;
  await addLog(`Verificação de links: ${ok} funcionando, ${broken} indisponível(is) e ${results.length - ok - broken} inconclusivo(s).`, broken ? 'error' : 'success');
  return { checked: results.length, ok, broken, unknown: results.length - ok - broken, results };
}

function whatsappAutoStartEnabled(
  config
) {
  if (
    process.env
      .WHATSAPP_AUTOSTART !==
    undefined
  ) {
    return ![
      '0',
      'false',
      'no'
    ].includes(
      String(
        process.env
          .WHATSAPP_AUTOSTART
      ).toLowerCase()
    );
  }

  return (
    config.whatsappAutoStart !==
    false
  );
}

/*
 * ==========================================================
 * RODADAS DE PUBLICAÇÃO
 * ==========================================================
 */

function normalizeAudienceCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function normalizeCouponAudienceCodes(codes) {
  return [
    ...new Set(
      (Array.isArray(codes) ? codes : [])
        .map((code) => normalizeAudienceCode(code))
        .filter((code) => /^G\d+$/.test(code))
    )
  ].slice(0, 50);
}

function formatCouponMessage(coupon) {
  const title = String(coupon?.title || 'Cupom disponível').trim();
  const description = String(coupon?.description || '').trim();
  const code = String(coupon?.code || '').trim();
  const discountType = String(coupon?.discountType || '').trim();
  const discountValue = Number(coupon?.discountValue || 0);
  const minPurchase = Number(coupon?.minPurchase || 0);
  const expiresAt = coupon?.expiresAt ? new Date(coupon.expiresAt) : null;
  const parts = [`🎟️ *${title}*`];

  if (description) parts.push(description);
  if (discountValue > 0) {
    const suffix = discountType === 'fixed' ? ' OFF' : discountType === 'free-shipping' ? '' : '% OFF';
    const prefix = discountType === 'fixed' ? 'R$ ' : '';
    parts.push(`💸 Desconto: *${prefix}${discountValue}${suffix}*`);
  }
  if (code) parts.push(`🏷️ Código: *${code}*`);
  if (minPurchase > 0) parts.push(`🛒 Válido em compras acima de *R$ ${minPurchase.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}*`);
  if (discountType === 'free-shipping') parts.push('🚚 Frete grátis conforme as regras da loja.');
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
    parts.push(`⏰ Válido até ${expiresAt.toLocaleDateString('pt-BR')}.`);
  } else {
    parts.push('⏰ Validade não informada pela loja; confirme antes de usar.');
  }
  if (coupon?.link) parts.push(`👉 Ative aqui: ${coupon.shortUrl || coupon.link}`);
  parts.push('⚠️ Confira as regras e a validade antes de usar.');
  return parts.filter(Boolean).join('\n\n');
}

function getRoundAudienceCodes(data) {
  const audiences =
    Array.isArray(
      data.config
        ?.whatsappAudiences
    )
      ? data.config
          .whatsappAudiences
      : [];

  const whatsappGroups =
    Array.isArray(
      data.meta
        ?.whatsapp
        ?.groups
    )
      ? data.meta
          .whatsapp
          .groups
      : [];

  const availableGroupCodes =
    new Set();

  for (
    const group
    of whatsappGroups
  ) {
    const name =
      String(
        group.name || ''
      ).trim();

    const match =
      name.match(
        /(?:\||\s)(G\d+)\s*$/i
      );

    if (match?.[1]) {
      availableGroupCodes.add(
        normalizeAudienceCode(
          match[1]
        )
      );
    }
  }

  return audiences
    .filter(
      (audience) =>
        audience.enabled !==
        false
    )
    .map(
      (audience) =>
        normalizeAudienceCode(
          audience.code
        )
    )
    .filter(
      (code) =>
        /^G\d+$/.test(code)
    )
    .filter(
      (code) =>
        !availableGroupCodes.size ||
        availableGroupCodes.has(
          code
        )
    );
}

function getLocalCodesForQueueItem(
  item,
  offers,
  config
) {
  if (item?.kind === 'coupon') {
    return normalizeCouponAudienceCodes(item.targetAudienceCodes || item.couponSnapshot?.targetAudienceCodes);
  }

  const offer =
    offers.find(
      (entry) =>
        entry.id ===
        item.offerId
    ) ||
    item.offerSnapshot;

  if (!offer) {
    return [];
  }

  return [
    ...new Set(
      getAudienceCodesForOffer(
        offer,
        config.whatsappAudiences
      )
        .map(
          (code) =>
            normalizeAudienceCode(
              code
            )
        )
        .filter(Boolean)
    )
  ];
}

async function getPublicationRound(
  createIfMissing = true
) {
  /*
   * Enquanto as lojas são consultadas, nenhuma nova publicação
   * começa. A rodada que já estava ativa sempre tem prioridade e
   * impede a coleta de começar por meio de runCollectionWhenIdle().
   */
  if (collectionInProgress) {
    return null;
  }

  let result = null;

  await updateStore(
    (data) => {
      if (collectionInProgress) {
        return;
      }

      data.meta =
        data.meta || {};

      const audienceCodes =
        getRoundAudienceCodes(
          data
        );

      if (
        !audienceCodes.length
      ) {
        data.meta.publicationRound =
          null;

        return;
      }

      let round =
        data.meta
          .publicationRound;

      const validRound =
        round &&
        Array.isArray(
          round
            .pendingAudienceCodes
        ) &&
        round
          .pendingAudienceCodes
          .length;

      if (!validRound) {
        if (!createIfMissing) {
          data.meta
            .publicationRound =
            null;

          return;
        }

        round = {
          id:
            createId(
              'round'
            ),

          startedAt:
            new Date()
              .toISOString(),

          pendingAudienceCodes:
            [...audienceCodes],

          usedOfferIds: []
        };

        data.meta
          .publicationRound =
          round;
      } else {
        round
          .pendingAudienceCodes =
          round
            .pendingAudienceCodes
            .map(
              (code) =>
                normalizeAudienceCode(
                  code
                )
            )
            .filter(
              (code) =>
                audienceCodes.includes(
                  code
                )
            );

        round.usedOfferIds =
          Array.isArray(
            round.usedOfferIds
          )
            ? round.usedOfferIds
            : [];

        if (
          !round
            .pendingAudienceCodes
            .length
        ) {
          data.meta
            .publicationRound =
            null;

          return;
        }
      }

      result = {
        id:
          round.id,

        pendingAudienceCodes:
          [
            ...round
              .pendingAudienceCodes
          ],

        usedOfferIds:
          [
            ...round
              .usedOfferIds
          ]
      };
    }
  );

  return result;
}

async function skipRoundAudience(
  roundId,
  audienceCode
) {
  await updateStore(
    (data) => {
      const round =
        data.meta
          ?.publicationRound;

      if (
        !round ||
        round.id !==
        roundId
      ) {
        return;
      }

      round.pendingAudienceCodes =
        (
          round
            .pendingAudienceCodes ||
          []
        ).filter(
          (code) =>
            normalizeAudienceCode(
              code
            ) !==
            normalizeAudienceCode(
              audienceCode
            )
        );

      if (
        !round
          .pendingAudienceCodes
          .length
      ) {
        round.completedAt =
          new Date()
            .toISOString();

        data.meta
          .lastPublicationRound = {
          ...round
        };

        data.meta
          .publicationRound =
          null;
      }
    }
  );
}

/*
 * ==========================================================
 * CORS / HEADERS
 * ==========================================================
 */

const allowedOrigins =
  String(
    process.env.SITE_URL || ''
  )
    .split(',')
    .map(
      (value) =>
        value
          .trim()
          .replace(/\/$/, '')
    )
    .filter(Boolean);

app.use(
  cors({
    origin(
      origin,
      callback
    ) {
      if (
        !origin ||
        allowedOrigins.includes(
          origin.replace(
            /\/$/,
            ''
          )
        )
      ) {
        return callback(
          null,
          true
        );
      }

      return callback(
        null,
        false
      );
    }
  })
);

app.use(
  (
    req,
    res,
    next
  ) => {
    res.setHeader(
      'X-Content-Type-Options',
      'nosniff'
    );

    res.setHeader(
      'X-Frame-Options',
      'DENY'
    );

    res.setHeader(
      'Referrer-Policy',
      'strict-origin-when-cross-origin'
    );

    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );

    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'"
    );

    if (
      req.secure ||
      req.headers[
        'x-forwarded-proto'
      ] === 'https'
    ) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      );
    }

    if (
      req.path.startsWith(
        '/api/admin'
      ) ||
      req.path.startsWith(
        '/api/auth'
      ) ||
      req.path.startsWith(
        '/api/assistant'
      )
    ) {
      res.setHeader(
        'Cache-Control',
        'no-store'
      );
    }

    next();
  }
);

app.use(
  express.json({
    limit: '1mb'
  })
);

app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

/*
 * ==========================================================
 * WHATSAPP WORKER
 * ==========================================================
 */

async function startWhatsappWorker({
  mode = 'qr',
  phoneNumber = '',
  automatic = false
} = {}) {
  if (
    whatsappProcess &&
    whatsappProcess.exitCode ===
    null
  ) {
    return {
      started: false,
      message:
        'Publicador já está em execução.'
    };
  }

  if (
    whatsappRestartTimer
  ) {
    clearTimeout(
      whatsappRestartTimer
    );
  }

  whatsappRestartTimer =
    null;

  whatsappStopRequested =
    false;

  const child =
    spawn(
      process.execPath,
      [
        path.join(
          root,
          'worker',
          'whatsapp.js'
        )
      ],
      {
        cwd: root,

        env: {
          ...process.env,

          PAIRING_PHONE_NUMBER:
            mode === 'phone'
              ? phoneNumber
              : ''
        },

        windowsHide: true,
        stdio: 'inherit'
      }
    );

  whatsappProcess =
    child;

  child.once(
    'exit',
    async (code) => {
      if (
        whatsappProcess ===
        child
      ) {
        whatsappProcess =
          null;
      }

      await updateStore(
        (store) => {
          if (
            store.meta
              .whatsapp
              ?.status ===
            'error'
          ) {
            return;
          }

          store.meta.whatsapp = {
            ...store.meta
              .whatsapp,

            status:
              'offline',

            lastSeenAt:
              new Date()
                .toISOString(),

            message:
              `Publicador encerrado (${code ?? 'sem código'}).`
          };
        }
      );

      const {
        config
      } =
        await readStore();

      if (
        whatsappStopRequested ||
        !whatsappAutoStartEnabled(
          config
        )
      ) {
        return;
      }

      whatsappRestartAttempts +=
        1;

      const delay =
        Math.min(
          300_000,

          10_000 *
          (
            2 **
            Math.min(
              whatsappRestartAttempts -
              1,
              5
            )
          )
        );

      await addLog(
        `WhatsApp será reiniciado automaticamente em ${Math.round(delay / 1000)} segundos.`,
        'info'
      );

      whatsappRestartTimer =
        setTimeout(
          () => {
            startWhatsappWorker({
              automatic: true
            }).catch(
              (error) =>
                addLog(
                  `Falha ao reiniciar o WhatsApp: ${error.message}`,
                  'error'
                )
            );
          },
          delay
        );
    }
  );

  await updateStore(
    (store) => {
      store.meta.whatsapp = {
        ...store.meta
          .whatsapp,

        status:
          'starting',

        qrDataUrl: null,
        pairingCode: null,

        message:
          automatic
            ? 'Restaurando a conexão do WhatsApp…'
            : mode ===
              'phone'
              ? 'Gerando código de pareamento…'
              : 'Gerando QR Code…'
      };
    }
  );

  return {
    started: true,

    message:
      automatic
        ? 'Publicador iniciado automaticamente.'
        : mode === 'phone'
          ? 'Aguarde o código de pareamento.'
          : 'Aguarde o QR Code.'
  };
}



/*
 * ==========================================================
 * ROTAS PÚBLICAS
 * ==========================================================
 */

app.get(
  '/api/health',
  (_req, res) => {
    const aiStatus =
      getAiAvailability();

    res.json({
      ok: true,

      time:
        new Date()
          .toISOString(),

      aiGenerationVersion,

      aiTextMode:
        'ai-with-local-fallback',

      ai: {
        available:
          aiStatus.available,

        provider:
          aiStatus.provider,

        model:
          aiStatus.model,

        lastSuccessAt:
          aiStatus.lastSuccessAt,

        lastFailureAt:
          aiStatus.lastFailureAt
      }
    });
  }
);

app.get(
  '/api/config/public',
  async (
    _req,
    res
  ) => {
    const {
      config
    } =
      await readStore();

    const {
      brandName,
      heroTitle,
      heroText,
      primaryColor,
      whatsappUrl,
      disclosure,
      contactEmail,
      canonicalUrl,
      seoSiteName,
      seoTitle,
      seoDescription,
      seoKeywords,
      seoImageUrl,
      seoIndexingEnabled,
      seoStructuredDataEnabled,
      publicOfferPageSize,
      smartRankingEnabled,
      duplicateGroupingEnabled,
      rankingDiversityEnabled,
      publicAdvancedFiltersEnabled,
      favoritesEnabled,
      showOfferUpdatedAt,
      affiliateDisclosureLabel,
      mobileCompactMenu,
      clickAnalyticsEnabled,
      legalPolicyVersion,
      analyticsVisitorRetentionDays,
      analyticsDailyRetentionDays,
      legalResponsibleName,
      legalResponsibleType,
      legalCityState,
      legalPrivacyEmail,
      legalResponseBusinessDays,
      legalContactRetentionMonths,
      legalConsentRetentionYears,
      legalAffiliatePrograms,
      legalAboutCustomText,
      legalContactCustomText,
      legalTermsCustomText,
      legalPrivacyCustomText
    } = config;

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({
      brandName,
      heroTitle,
      heroText,
      primaryColor,
      whatsappUrl,
      disclosure,
      contactEmail,
      canonicalUrl,
      seoSiteName,
      seoTitle,
      seoDescription,
      seoKeywords,
      seoImageUrl,
      seoIndexingEnabled,
      seoStructuredDataEnabled,
      publicOfferPageSize,
      smartRankingEnabled,
      duplicateGroupingEnabled,
      rankingDiversityEnabled,
      publicAdvancedFiltersEnabled,
      favoritesEnabled,
      showOfferUpdatedAt,
      affiliateDisclosureLabel,
      mobileCompactMenu,
      clickAnalyticsEnabled,
      legalPolicyVersion,
      analyticsVisitorRetentionDays,
      analyticsDailyRetentionDays,
      legalResponsibleName,
      legalResponsibleType,
      legalCityState,
      legalPrivacyEmail,
      legalResponseBusinessDays,
      legalContactRetentionMonths,
      legalConsentRetentionYears,
      legalAffiliatePrograms,
      legalAboutCustomText,
      legalContactCustomText,
      legalTermsCustomText,
      legalPrivacyCustomText,

      assistantAvailable: config.assistantEnabled !== false
    });
  }
);

const publicHomeConfigKeys = [
  'brandName', 'heroTitle', 'heroText', 'primaryColor', 'whatsappUrl',
  'disclosure', 'contactEmail', 'canonicalUrl', 'seoSiteName', 'seoTitle',
  'seoDescription', 'seoKeywords', 'seoImageUrl', 'seoIndexingEnabled',
  'seoStructuredDataEnabled', 'publicOfferPageSize', 'smartRankingEnabled',
  'duplicateGroupingEnabled', 'rankingDiversityEnabled', 'publicAdvancedFiltersEnabled',
  'favoritesEnabled', 'showOfferUpdatedAt', 'affiliateDisclosureLabel',
  'mobileCompactMenu', 'clickAnalyticsEnabled', 'legalPolicyVersion',
  'analyticsVisitorRetentionDays', 'analyticsDailyRetentionDays', 'legalResponsibleName',
  'legalResponsibleType', 'legalCityState', 'legalPrivacyEmail',
  'legalResponseBusinessDays', 'legalContactRetentionMonths', 'legalConsentRetentionYears',
  'legalAffiliatePrograms', 'legalAboutCustomText', 'legalContactCustomText',
  'legalTermsCustomText', 'legalPrivacyCustomText'
];

function publicHomeConfig(config) {
  const payload = Object.fromEntries(publicHomeConfigKeys.map((key) => [key, config[key]]));
  payload.assistantAvailable = config.assistantEnabled !== false;
  return payload;
}

function publicHomeCoupons(coupons, req) {
  const now = Date.now();
  return (Array.isArray(coupons) ? coupons : [])
    .filter((coupon) => {
      if (coupon.active === false) return false;
      if (!coupon.expiresAt) return true;
      const expiresAt = new Date(coupon.expiresAt).getTime();
      return Number.isNaN(expiresAt) || expiresAt >= now;
    })
    .sort((a, b) => Number(b.featured) - Number(a.featured) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 6)
    .map(({ targetAudienceCodes, ...coupon }) => ({
      ...coupon,
      shortUrl: couponShortUrl(coupon, req)
    }));
}

function publicHomeAudiences(config) {
  return (Array.isArray(config.whatsappAudiences) ? config.whatsappAudiences : [])
    .filter((audience) => audience.enabled !== false && audience.whatsappLink)
    .map((audience) => ({
      code: String(audience.code || ''),
      name: String(audience.name || ''),
      whatsappLink: String(audience.whatsappLink || '')
    }));
}

app.get('/api/home', async (req, res) => {
  const data = await readStore();
  const activeCoupons = (Array.isArray(data.coupons) ? data.coupons : []).filter((coupon) => {
    if (coupon.active === false) return false;
    if (!coupon.expiresAt) return true;
    const expiresAt = new Date(coupon.expiresAt).getTime();
    return Number.isNaN(expiresAt) || expiresAt >= Date.now();
  });
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.json({
    config: publicHomeConfig(data.config),
    coupons: publicHomeCoupons(data.coupons, req),
    couponTotal: activeCoupons.length,
    audiences: publicHomeAudiences(data.config)
  });
});

app.get(
  '/api/offers',
  async (
    req,
    res
  ) => {
    const { offers, config, analytics } = await readStore();
    const nowMs = Date.now();
    const eligible = (Array.isArray(offers) ? offers : [])
      .filter((offer) => publicOfferAllowed(offer, config, nowMs));

    if (String(req.query?.paged || '') !== '1') {
      return res.json(eligible.sort((a, b) => Number(b.featured) - Number(a.featured)));
    }

    const query = String(req.query?.query || '').trim().toLocaleLowerCase('pt-BR').slice(0, 120);
    const store = String(req.query?.store || '').trim().slice(0, 80);
    const sort = ['smart', 'discount', 'recent', 'price'].includes(String(req.query?.sort)) ? String(req.query.sort) : (config.smartRankingEnabled === false ? 'discount' : 'smart');
    const limit = Math.round(boundedNumber(req.query?.limit, config.publicOfferPageSize || 24, 6, 60));
    const offset = Math.round(boundedNumber(req.query?.offset, 0, 0, 100000));
    const category = String(req.query?.category || '').trim().slice(0, 100);
    const minPrice = String(req.query?.minPrice || '').trim() ? boundedNumber(req.query.minPrice, 0, 0, 10000000) : 0;
    const maxPrice = String(req.query?.maxPrice || '').trim() ? boundedNumber(req.query.maxPrice, 10000000, 0, 10000000) : 10000000;
    const minDiscount = String(req.query?.minDiscount || '').trim() ? boundedNumber(req.query.minDiscount, 0, 0, 95) : 0;
    const freeShipping = String(req.query?.freeShipping || '') === '1';
    const requestedIds = new Set(String(req.query?.ids || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100));
    const stores = [...new Set(eligible.map((offer) => String(offer.store || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const categories = [...new Set(eligible.map((offer) => String(offer.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    let filtered = eligible.filter((offer) => {
      const searchable = `${offer.title || ''} ${offer.store || ''} ${offer.category || ''}`.toLocaleLowerCase('pt-BR');
      const price = Number(offer.price || 0);
      return (!query || searchable.includes(query))
        && (!requestedIds.size || requestedIds.has(offer.id))
        && (!store || store === 'Todas' || offer.store === store || catalogSlug(offer.store) === store)
        && (!category || offer.category === category || catalogSlug(offer.category) === category)
        && price >= minPrice && price <= maxPrice
        && offerDiscount(offer) >= minDiscount
        && (!freeShipping || offer.freeShipping === true);
    }).sort((a, b) => {
      if (sort === 'price') return Number(a.price || 0) - Number(b.price || 0);
      if (sort === 'recent') return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
      if (sort === 'smart') return smartOfferScore(b, config, analytics, nowMs) - smartOfferScore(a, config, analytics, nowMs);
      return offerDiscount(b) - offerDiscount(a) || Number(b.featured) - Number(a.featured);
    });

    if (config.duplicateGroupingEnabled !== false) {
      const seen = new Set();
      filtered = filtered.filter((offer) => {
        const key = productFingerprint(offer) || offer.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (sort === 'smart' && config.rankingDiversityEnabled !== false) filtered = diversifyOffers(filtered);

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return res.json({
      offers: filtered.slice(offset, offset + limit).map((offer) => ({
        ...offer,
        publicSlug: offerPublicSlug(offer),
        qualityScore: offerQuality(offer, config).score,
        rankingScore: smartOfferScore(offer, config, analytics, nowMs)
      })),
      total: filtered.length,
      offset,
      limit,
      stores,
      categories,
      topDiscount: Math.max(0, ...eligible.map(offerDiscount))
    });
  }
);

app.get('/api/catalog/meta', async (_req, res) => {
  const { offers, config } = await readStore();
  const eligible = (offers || []).filter((offer) => publicOfferAllowed(offer, config));
  const countBy = (key) => Object.values(eligible.reduce((map, offer) => {
    const name = String(offer[key] || '').trim();
    if (!name) return map;
    map[name] ||= { name, slug: catalogSlug(name), count: 0 };
    map[name].count += 1;
    return map;
  }, {})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ stores: countBy('store'), categories: countBy('category') });
});

app.get('/api/search/suggestions', async (req, res) => {
  const query = String(req.query?.q || '').trim().toLocaleLowerCase('pt-BR').slice(0, 80);
  if (query.length < 2) return res.json([]);
  const { offers, config } = await readStore();
  const suggestions = (offers || []).filter((offer) => publicOfferAllowed(offer, config) && `${offer.title} ${offer.store} ${offer.category}`.toLocaleLowerCase('pt-BR').includes(query))
    .slice(0, 8).map((offer) => ({ title: offer.title, store: offer.store, slug: offerPublicSlug(offer) }));
  res.set('Cache-Control', 'public, max-age=60');
  res.json(suggestions);
});

app.get('/api/offer/:slug', async (req, res) => {
  const { offers, config, analytics } = await readStore();
  const eligible = (offers || []).filter((offer) => publicOfferAllowed(offer, config));
  const offer = eligible.find((entry) => offerPublicSlug(entry) === req.params.slug);
  if (!offer) return res.status(404).json({ error: 'Oferta não encontrada ou não está mais disponível.' });
  const fingerprint = productFingerprint(offer);
  const comparisons = eligible.filter((entry) => entry.id !== offer.id && productFingerprint(entry) === fingerprint)
    .sort((a, b) => Number(a.price || 0) - Number(b.price || 0)).slice(0, 6);
  const related = eligible.filter((entry) => entry.id !== offer.id && entry.category === offer.category && !comparisons.some((item) => item.id === entry.id))
    .sort((a, b) => smartOfferScore(b, config, analytics) - smartOfferScore(a, config, analytics)).slice(0, 6);
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  res.json({ offer: { ...offer, publicSlug: offerPublicSlug(offer), qualityScore: offerQuality(offer, config).score }, comparisons: comparisons.map((entry) => ({ ...entry, publicSlug: offerPublicSlug(entry) })), related: related.map((entry) => ({ ...entry, publicSlug: offerPublicSlug(entry) })) });
});

app.get(
  '/api/coupons',
  async (req, res) => {
    const { coupons } = await readStore();
    const now = Date.now();

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');

    res.json(
      (Array.isArray(coupons) ? coupons : [])
        .filter((coupon) => {
          if (coupon.active === false) return false;
          if (!coupon.expiresAt) return true;
          const expiresAt = new Date(coupon.expiresAt).getTime();
          return Number.isNaN(expiresAt) || expiresAt >= now;
        })
        .sort((a, b) => Number(b.featured) - Number(a.featured) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 300)
        .map(({ targetAudienceCodes, ...coupon }) => ({
          ...coupon,
          shortUrl: couponShortUrl(coupon, req)
        }))
    );
  }
);

app.get(
  '/c/:code',
  async (req, res) => {
    const code = String(req.params.code || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{4,80}$/.test(code)) return res.status(404).send('Cupom não encontrado.');

    const { coupons } = await readStore();
    const coupon = (Array.isArray(coupons) ? coupons : []).find((entry) => couponShortCode(entry) === code);
    if (!coupon || coupon.active === false) return res.status(404).send('Cupom não encontrado ou inativo.');

    if (coupon.expiresAt) {
      const expiresAt = new Date(coupon.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return res.status(410).send('Este cupom expirou.');
    }

    let destination;
    try {
      destination = new URL(String(coupon.link || '').trim());
    } catch {
      destination = null;
    }
    if (!destination || !['http:', 'https:'].includes(destination.protocol)) return res.status(404).send('Link do cupom indisponível.');

    return res.redirect(302, destination.toString());
  }
);

app.post(
  '/api/contact',
  async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = checkContactLimit(clientIp);

    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({
        error: 'Muitas mensagens enviadas. Aguarde alguns minutos e tente novamente.'
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();
    const honeypot = String(body.website || '').trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (honeypot) return res.json({ ok: true });

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: 'Informe um nome entre 2 e 80 caracteres.' });
    }

    if (!emailPattern.test(email) || email.length > 200) {
      return res.status(400).json({ error: 'Informe um e-mail válido.' });
    }

    if (subject.length < 3 || subject.length > 120) {
      return res.status(400).json({ error: 'Selecione um assunto válido.' });
    }

    if (message.length < 10 || message.length > 4000) {
      return res.status(400).json({ error: 'Escreva uma mensagem entre 10 e 4.000 caracteres.' });
    }

    const apiKey = String(process.env.BREVO_API_KEY || '').trim();
    const { config } = await readStore();
    const recipient = String(process.env.CONTACT_EMAIL || config.contactEmail || 'contatopromoshop.site@gmail.com').trim();
    const senderEmail = String(process.env.BREVO_SENDER_EMAIL || recipient).trim();
    const senderName = String(process.env.BREVO_SENDER_NAME || 'PromoShop').trim();
    const copyToVisitor = email.toLowerCase() !== recipient.toLowerCase()
      ? [{ email, name }]
      : [];
    const inboxId = createId('inbox');
    const inboxItem = {
      id: inboxId,
      name,
      email,
      subject,
      message,
      replyAddress: inboundReplyAddress(config, inboxId),
      status: 'unread',
      deliveryStatus: 'pending',
      createdAt: new Date().toISOString(),
      readAt: null,
      repliedAt: null,
      replies: []
    };
    const textContent = [
      'PromoShop — nova mensagem recebida',
      '',
      `Nome: ${name}`,
      `E-mail: ${email}`,
      `Assunto: ${subject}`,
      '',
      'Mensagem:',
      message,
      '',
      'Para responder, use o botão de resposta do seu e-mail.',
      '',
      `© ${new Date().getFullYear()} PromoShop · promoshop.jhonatafaraujo.com.br`
      ].join('\n');

    await updateStore((data) => {
      data.inbox ||= [];
      data.inbox.unshift(inboxItem);
      pruneInboxEntries(data);
    });

    if (!apiKey) {
      return res.status(503).json({
        error: 'O formulário ainda não está conectado ao Brevo. Configure a chave do Brevo no Render ou use o e-mail exibido abaixo.'
      });
    }

    try {
      const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sender: {
            name: senderName,
            email: senderEmail
          },
          to: [{ email: recipient, name: 'PromoShop' }],
          ...(copyToVisitor.length ? { cc: copyToVisitor } : {}),
          replyTo: {
            email: inboxItem.replyAddress || email,
            name: inboxItem.replyAddress ? 'PromoShop atendimento' : name
          },
          subject: `PromoShop: ${subject}`,
          textContent,
          htmlContent: buildContactEmailHtml({ name, email, subject, message })
        })
      });

      if (!brevoResponse.ok) {
        const details = (await brevoResponse.text()).slice(0, 300);
        console.error(`Brevo recusou o formulário (${brevoResponse.status}): ${details}`);
        await updateStore((data) => {
          const entry = data.inbox?.find((item) => item.id === inboxItem.id);
          if (entry) {
            entry.deliveryStatus = 'failed';
            entry.deliveryError = `Brevo recusou o envio (${brevoResponse.status}).`;
          }
        }).catch(() => { });
        return res.status(502).json({
          error: 'O serviço de e-mail não aceitou a mensagem. Tente novamente ou use o e-mail exibido na página.'
        });
      }

      const brevoResult = await brevoResponse.json().catch(() => ({}));
      await updateStore((data) => {
        const entry = data.inbox?.find((item) => item.id === inboxItem.id);
        if (entry) {
          entry.deliveryStatus = 'sent';
          entry.deliveredAt = new Date().toISOString();
          entry.messageId = String(brevoResult.messageId || brevoResult.message_id || '').trim();
        }
      });

      return res.json({ ok: true });
    } catch (error) {
      console.error('Falha ao enviar formulário pelo Brevo:', error.message);
      await updateStore((data) => {
        const entry = data.inbox?.find((item) => item.id === inboxItem.id);
        if (entry) {
          entry.deliveryStatus = 'failed';
          entry.deliveryError = 'Falha de comunicação com o serviço de e-mail.';
        }
      }).catch(() => { });
      return res.status(502).json({
        error: 'Não foi possível enviar agora. Tente novamente em alguns instantes.'
      });
    }
  }
);

app.patch(
  '/api/admin/inbox/:id',
  requireAdmin,
  async (req, res) => {
    const requestedStatus = String(req.body?.status || '').trim().toLowerCase();
    const nextStatus = requestedStatus === 'unread' ? 'unread' : 'read';
    let updated = null;

    await updateStore((data) => {
      const entry = data.inbox?.find((item) => item.id === req.params.id);
      if (!entry) return;

      entry.status = nextStatus;
      entry.readAt = nextStatus === 'read' ? (entry.readAt || new Date().toISOString()) : null;
      updated = { ...entry, replies: Array.isArray(entry.replies) ? entry.replies : [] };
    });

    if (!updated) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    res.json({ ok: true, message: updated });
  }
);

app.delete(
  '/api/admin/inbox/:id',
  requireAdmin,
  async (req, res) => {
    let removed = false;

    await updateStore((data) => {
      const inbox = Array.isArray(data.inbox) ? data.inbox : [];
      const previousLength = inbox.length;
      data.inbox = inbox.filter((item) => item.id !== req.params.id);
      removed = data.inbox.length < previousLength;
    });

    if (!removed) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    await addLog('Mensagem da caixa de entrada excluída pelo administrador.', 'info');
    res.json({ ok: true });
  }
);

app.post(
  '/api/admin/inbox/:id/reply',
  requireAdmin,
  async (req, res) => {
    const replyMessage = String(req.body?.message || '').trim();
    if (replyMessage.length < 1 || replyMessage.length > 4000) {
      return res.status(400).json({ error: 'Escreva uma resposta entre 1 e 4.000 caracteres.' });
    }

    const store = await readStore();
    const { config } = store;
    const inbox = store.inbox || [];
    const entry = inbox.find((item) => item.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Mensagem não encontrada.' });

    const apiKey = String(process.env.BREVO_API_KEY || '').trim();
    const senderEmail = String(process.env.BREVO_SENDER_EMAIL || config.contactEmail || '').trim();
    const senderName = String(process.env.BREVO_SENDER_NAME || config.brandName || 'PromoShop').trim();

    if (!apiKey || !senderEmail) {
      return res.status(503).json({ error: 'Configure a chave e o remetente da Brevo no Render antes de responder.' });
    }

    try {
      const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: entry.email, name: entry.name }],
          replyTo: { email: entry.replyAddress || senderEmail, name: senderName },
          subject: 'Resposta do PromoShop',
          textContent: `Olá, ${entry.name}!\n\n${replyMessage}\n\nObrigado por entrar em contato com o PromoShop.\n\n© ${new Date().getFullYear()} PromoShop · promoshop.jhonatafaraujo.com.br`,
          htmlContent: buildContactReplyHtml({ name: entry.name, message: replyMessage })
        })
      });

      if (!brevoResponse.ok) {
        const details = (await brevoResponse.text()).slice(0, 300);
        console.error(`Brevo recusou a resposta do inbox (${brevoResponse.status}): ${details}`);
        return res.status(502).json({ error: 'A Brevo recusou a resposta. Confira o remetente, a chave e os IPs autorizados.' });
      }

      const brevoResult = await brevoResponse.json().catch(() => ({}));
      let updated = null;
      await updateStore((data) => {
        const current = data.inbox?.find((item) => item.id === entry.id);
        if (!current) return;
        current.status = 'replied';
        current.readAt ||= new Date().toISOString();
        current.repliedAt = new Date().toISOString();
        current.replies ||= [];
        current.replies.push({
          id: createId('reply'),
          direction: 'outbound',
          name: senderName,
          email: senderEmail,
          message: replyMessage,
          messageId: String(brevoResult.messageId || brevoResult.message_id || '').trim(),
          createdAt: new Date().toISOString(),
          status: 'sent'
        });
        current.replies = current.replies.slice(-20);
        updated = { ...current };
      });

      await addLog(`Resposta enviada pelo inbox para ${entry.email}.`, 'success');
      res.json({ ok: true, message: updated });
    } catch (error) {
      console.error('Falha ao responder pelo inbox:', error.message);
      res.status(502).json({ error: 'Não foi possível enviar a resposta agora. Tente novamente.' });
    }
  }
);

app.post(
  '/api/webhooks/brevo/inbound',
  async (req, res) => {
    const secrets = await readSecrets();
    if (!secretsMatch(req.query?.token, secrets.brevoInboundToken)) {
      return res.status(401).json({ error: 'Webhook não autorizado.' });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    let imported = 0;

    await updateStore((data) => {
      data.inbox ||= [];
      const inboundDomain = normalizeInboundDomain(data.config?.inboxInboundDomain);

      for (const item of items.slice(0, 20)) {
        const messageId = String(item?.MessageId || item?.messageId || '').trim();
        const fromAddress = mailboxAddress(item?.From || item?.from);
        const fromName = mailboxName(item?.From || item?.from) || fromAddress;
        const addresses = [
          ...(Array.isArray(item?.To) ? item.To : []),
          ...(Array.isArray(item?.Recipients) ? item.Recipients : []),
          ...(Array.isArray(item?.Cc) ? item.Cc : [])
        ].map(mailboxAddress).filter(Boolean);
        const replyAddress = addresses.find((address) => inboundDomain && address.endsWith(`@${inboundDomain}`)) || '';
        const message = String(item?.ExtractedMarkdownMessage || item?.RawTextBody || item?.RawHtmlBody || '').trim().slice(0, 8000);
        const subject = String(item?.Subject || '').trim().slice(0, 240);

        if (!fromAddress || !message) continue;

        const alreadyImported = data.inbox.some((entry) => entry.messageId === messageId || entry.replies?.some((reply) => reply.messageId && reply.messageId === messageId));
        if (alreadyImported) continue;

        const original = data.inbox.find((entry) => (
          (entry.replyAddress && addresses.includes(entry.replyAddress)) ||
          (entry.messageId && item?.InReplyTo && entry.messageId === item.InReplyTo) ||
          entry.replies?.some((reply) => reply.messageId && item?.InReplyTo && reply.messageId === item.InReplyTo)
        ));

        const inboundMessage = {
          id: createId('reply'),
          direction: 'inbound',
          name: fromName,
          email: fromAddress,
          message,
          subject,
          messageId,
          createdAt: new Date().toISOString(),
          status: 'received'
        };

        if (original) {
          original.replies ||= [];
          original.replies.push(inboundMessage);
          original.replies = original.replies.slice(-20);
          original.status = 'unread';
          original.lastInboundAt = inboundMessage.createdAt;
        } else {
          data.inbox.unshift({
            id: createId('inbox'),
            name: fromName,
            email: fromAddress,
            message,
            subject,
            replyAddress,
            messageId,
            status: 'unread',
            deliveryStatus: 'inbound',
            createdAt: inboundMessage.createdAt,
            readAt: null,
            repliedAt: null,
            replies: []
          });
        }

        imported += 1;
      }

      pruneInboxEntries(data);
    });

    if (imported) await addLog(`${imported} resposta(s) de e-mail recebida(s) no painel.`, 'success');
    res.json({ ok: true, imported });
  }
);

app.post(
  '/api/admin/inbox/setup',
  requireAdmin,
  async (req, res) => {
    const domain = normalizeInboundDomain(req.body?.domain);
    if (!isValidInboundDomain(domain)) {
      return res.status(400).json({ error: 'Informe um subdomínio válido, como reply.jhonatafaraujo.com.br.' });
    }

    const store = await readStore();
    const secrets = await readSecrets();
    const apiKey = String(process.env.BREVO_API_KEY || '').trim();
    const senderEmail = String(process.env.BREVO_SENDER_EMAIL || store.config.contactEmail || '').trim().toLowerCase();
    const senderDomain = senderEmail.split('@')[1] || '';

    if (!apiKey) return res.status(503).json({ error: 'Configure BREVO_API_KEY no Render antes de ativar o recebimento.' });
    if (senderDomain && domain === senderDomain) {
      return res.status(400).json({ error: 'Use um subdomínio diferente do domínio usado para enviar, por exemplo reply.jhonatafaraujo.com.br.' });
    }

    const webhookUrl = inboundWebhookUrl(req, secrets.brevoInboundToken);
    const payload = {
      type: 'inbound',
      events: ['inboundEmailProcessed'],
      url: webhookUrl,
      domain,
      description: 'PromoShop — respostas da caixa de entrada'
    };

    let endpoint = 'https://api.brevo.com/v3/webhooks';
    let method = 'POST';
    if (store.config.inboxInboundWebhookId) {
      endpoint = `${endpoint}/${encodeURIComponent(store.config.inboxInboundWebhookId)}`;
      method = 'PUT';
    }

    let brevoResponse = await fetch(endpoint, {
      method,
      headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!brevoResponse.ok && method === 'PUT' && brevoResponse.status === 404) {
      brevoResponse = await fetch('https://api.brevo.com/v3/webhooks', {
        method: 'POST',
        headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!brevoResponse.ok) {
      const details = (await brevoResponse.text()).slice(0, 300);
      console.error(`Brevo recusou a configuração do inbound (${brevoResponse.status}): ${details}`);
      return res.status(502).json({ error: 'A Brevo recusou a configuração. Confira a chave, os IPs autorizados e o domínio.' });
    }

    const brevoResult = await brevoResponse.json().catch(() => ({}));
    await updateStore((data) => {
      data.config.inboxInboundEnabled = true;
      data.config.inboxInboundDomain = domain;
      data.config.inboxInboundWebhookId = String(brevoResult.id || data.config.inboxInboundWebhookId || '').trim();
      data.config.inboxInboundWebhookUrl = webhookUrl;
    });
    await addLog(`Recebimento de respostas por e-mail ativado em ${domain}.`, 'success');

    res.json({
      ok: true,
      domain,
      webhookUrl,
      webhookId: String(brevoResult.id || '').trim(),
      mxRecords: [
        { host: domain, type: 'MX', priority: 10, value: 'inbound1.sendinblue.com.' },
        { host: domain, type: 'MX', priority: 20, value: 'inbound2.sendinblue.com.' }
      ]
    });
  }
);

app.post(
  '/api/privacy/consent',
  async (req, res) => {
    const receiptId = normalizeAnalyticsId(req.body?.receiptId);
    const previousVisitorId = normalizeAnalyticsId(req.body?.previousVisitorId);
    const choice = String(req.body?.choice || '').trim();
    const policyVersion = String(req.body?.policyVersion || '').trim();

    if (!receiptId || !['accepted', 'rejected'].includes(choice) || !/^\d{4}-\d{2}-\d{2}(?:-v\d+)?$/.test(policyVersion)) {
      return res.status(400).json({ error: 'Comprovante de privacidade inválido.' });
    }

    const now = new Date();
    const nowMs = now.getTime();
    let versionAccepted = false;
    await updateStore((data) => {
      if (policyVersion !== String(data.config?.legalPolicyVersion || privacyPolicyVersion)) return;
      versionAccepted = true;
      const consentRetentionMs = boundedNumber(data.config?.consentReceiptRetentionYears, 5, 1, 10) * 365 * 24 * 60 * 60 * 1000;
      data.privacyConsents = data.privacyConsents && typeof data.privacyConsents === 'object'
        ? data.privacyConsents
        : {};
      data.privacyConsents[receiptId] = {
        receiptId,
        choice,
        policyVersion,
        updatedAt: now.toISOString()
      };

      for (const [id, receipt] of Object.entries(data.privacyConsents)) {
        const updatedAt = new Date(receipt?.updatedAt || 0).getTime();
        if (!Number.isFinite(updatedAt) || nowMs - updatedAt > consentRetentionMs) {
          delete data.privacyConsents[id];
        }
      }

      const receiptEntries = Object.entries(data.privacyConsents);
      if (receiptEntries.length > 50000) {
        receiptEntries
          .sort((left, right) => new Date(left[1]?.updatedAt || 0).getTime() - new Date(right[1]?.updatedAt || 0).getTime())
          .slice(0, receiptEntries.length - 50000)
          .forEach(([id]) => delete data.privacyConsents[id]);
      }

      if (choice === 'rejected' && previousVisitorId && data.analytics) {
        delete data.analytics.visitors?.[previousVisitorId];
        for (const day of Object.values(data.analytics.daily || {})) {
          if (day?.visitors) delete day.visitors[previousVisitorId];
        }
      }
    });

    if (!versionAccepted) return res.status(409).json({ error: 'A política foi atualizada. Revise sua escolha.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  }
);

app.post(
  '/api/analytics/visit',
  async (req, res) => {
    const limit = checkAnalyticsLimit(req.ip || req.socket.remoteAddress || 'unknown');
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Muitas medições em pouco tempo.' });
    }
    const visitorId = normalizeAnalyticsId(req.body?.visitorId);
    const sessionId = normalizeAnalyticsId(req.body?.sessionId);
    const receiptId = normalizeAnalyticsId(req.body?.receiptId);

    if (!visitorId || !sessionId || !receiptId) {
      return res.status(400).json({
        error: 'Identificador anônimo inválido.'
      });
    }

    const now = new Date();
    const nowMs = now.getTime();
    const dayKey = analyticsDay(now);
    let isNewVisitor = false;
    let isNewSession = false;
    let authorized = false;

    await updateStore((data) => {
      const consentReceipt = data.privacyConsents?.[receiptId];
      if (consentReceipt?.choice !== 'accepted' || consentReceipt.policyVersion !== String(data.config?.legalPolicyVersion || privacyPolicyVersion)) return;
      authorized = true;
      const visitorRetentionMs = boundedNumber(data.config?.analyticsVisitorRetentionDays, 365, 1, 730) * 24 * 60 * 60 * 1000;
      const dailyRetentionMs = boundedNumber(data.config?.analyticsDailyRetentionDays, 120, 7, 730) * 24 * 60 * 60 * 1000;
      data.analytics ||= {
        totalPageViews: 0,
        totalSessions: 0,
        totalVisitors: 0,
        visitors: {},
        daily: {}
      };
      data.analytics.visitors ||= {};
      data.analytics.daily ||= {};

      const previous = data.analytics.visitors[visitorId];
      isNewVisitor = !previous;
      isNewSession = isNewVisitor || !previous.lastSessionAt || nowMs - new Date(previous.lastSessionAt).getTime() >= analyticsSessionWindowMs;

      data.analytics.visitors[visitorId] = {
        firstSeenAt: previous?.firstSeenAt || now.toISOString(),
        lastSeenAt: now.toISOString(),
        lastSessionAt: isNewSession ? now.toISOString() : previous.lastSessionAt,
        pageViews: Number(previous?.pageViews || 0) + 1
      };

      data.analytics.totalPageViews = Number(data.analytics.totalPageViews || 0) + 1;
      if (isNewVisitor) data.analytics.totalVisitors = Number(data.analytics.totalVisitors || 0) + 1;
      if (isNewSession) data.analytics.totalSessions = Number(data.analytics.totalSessions || 0) + 1;

      const daily = data.analytics.daily[dayKey] ||= {
        pageViews: 0,
        sessions: 0,
        visitors: {}
      };
      daily.pageViews = Number(daily.pageViews || 0) + 1;
      daily.sessions = Number(daily.sessions || 0) + (isNewSession ? 1 : 0);
      daily.visitors ||= {};
      daily.visitors[visitorId] = true;

      for (const [id, visitor] of Object.entries(data.analytics.visitors)) {
        if (!visitor?.lastSeenAt || nowMs - new Date(visitor.lastSeenAt).getTime() > visitorRetentionMs) {
          delete data.analytics.visitors[id];
        }
      }

      const dailyCutoff = nowMs - dailyRetentionMs;
      for (const date of Object.keys(data.analytics.daily)) {
        const dateMs = new Date(`${date}T12:00:00-03:00`).getTime();
        if (!Number.isFinite(dateMs) || dateMs < dailyCutoff) delete data.analytics.daily[date];
      }
    });

    if (!authorized) return res.status(403).json({ error: 'Medição não autorizada.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  }
);

app.post(
  '/api/analytics/event',
  async (req, res) => {
    const limit = checkAnalyticsLimit(req.ip || req.socket.remoteAddress || 'unknown');
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Muitas medições em pouco tempo.' });
    }
    const receiptId = normalizeAnalyticsId(req.body?.receiptId);
    const visitorId = normalizeAnalyticsId(req.body?.visitorId);
    const sessionId = normalizeAnalyticsId(req.body?.sessionId);
    const type = String(req.body?.type || '').trim().toLowerCase();
    const targetId = String(req.body?.targetId || '').trim().slice(0, 120);
    const label = String(req.body?.label || '').trim().slice(0, 180);
    const store = String(req.body?.store || '').trim().slice(0, 80);
    const allowedTypes = ['offer', 'coupon', 'whatsapp', 'group', 'favorite'];

    if (!receiptId || !visitorId || !sessionId || !allowedTypes.includes(type) || !targetId) {
      return res.status(400).json({ error: 'Evento anônimo inválido.' });
    }

    let accepted = false;
    await updateStore((data) => {
      if (data.config?.clickAnalyticsEnabled === false) return;
      const receipt = data.privacyConsents?.[receiptId];
      if (!receipt || receipt.choice !== 'accepted' || receipt.policyVersion !== String(data.config?.legalPolicyVersion || privacyPolicyVersion)) return;
      accepted = true;
      const now = new Date();
      const dayKey = analyticsDay(now);
      data.analytics ||= {};
      data.analytics.totalClicks = Number(data.analytics.totalClicks || 0) + 1;
      data.analytics.clicksByType ||= {};
      data.analytics.clicksByStore ||= {};
      data.analytics.clicksByTarget ||= {};
      data.analytics.daily ||= {};
      data.analytics.clicksByType[type] = Number(data.analytics.clicksByType[type] || 0) + 1;
      if (store) data.analytics.clicksByStore[store] = Number(data.analytics.clicksByStore[store] || 0) + 1;
      const targetKey = `${type}:${targetId}`;
      const previousTarget = data.analytics.clicksByTarget[targetKey] || {};
      data.analytics.clicksByTarget[targetKey] = {
        id: targetId,
        type,
        label,
        store,
        count: Number(previousTarget.count || 0) + 1,
        lastClickedAt: now.toISOString()
      };
      const targetKeys = Object.keys(data.analytics.clicksByTarget);
      if (targetKeys.length > 2000) {
        targetKeys
          .sort((left, right) => new Date(data.analytics.clicksByTarget[left]?.lastClickedAt || 0) - new Date(data.analytics.clicksByTarget[right]?.lastClickedAt || 0))
          .slice(0, targetKeys.length - 2000)
          .forEach((key) => delete data.analytics.clicksByTarget[key]);
      }
      const day = data.analytics.daily[dayKey] ||= { pageViews: 0, sessions: 0, visitors: {} };
      day.clicks = Number(day.clicks || 0) + 1;
      day.clickers ||= {};
      day.clickers[visitorId] = true;
      const visitor = data.analytics.visitors?.[visitorId];
      if (visitor) {
        visitor.lastClickedAt = now.toISOString();
        visitor.clicks = Number(visitor.clicks || 0) + 1;
      }
    });

    if (!accepted) return res.status(403).json({ error: 'Medição não autorizada.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  }
);

app.get(
  '/api/audiences/public',
  async (
    _req,
    res
  ) => {
    const {
      config
    } =
      await readStore();

    const audiences =
      Array.isArray(
        config
          .whatsappAudiences
      )
        ? config
            .whatsappAudiences
        : [];

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(
      audiences
        .filter(
          (audience) =>
            audience.enabled !==
            false &&
            audience.whatsappLink
        )
        .map(
          (audience) => ({
            code:
              String(
                audience.code ||
                ''
              ),

            name:
              String(
                audience.name ||
                ''
              ),

            whatsappLink:
              String(
                audience
                  .whatsappLink ||
                ''
              )
          })
        )
    );
  }
);

/*
 * ==========================================================
 * LOGIN
 * ==========================================================
 */

app.post(
  '/api/auth/login',
  async (
    req,
    res
  ) => {
    const clientIp =
      req.ip ||
      req.socket
        .remoteAddress ||
      'unknown';

    const attemptState =
      loginAttemptState(
        clientIp
      );

    if (
      attemptState
        .blockedUntil >
      Date.now()
    ) {
      const retryAfter =
        Math.max(
          1,
          Math.ceil(
            (
              attemptState
                .blockedUntil -
              Date.now()
            ) /
            1000
          )
        );

      res.setHeader(
        'Retry-After',
        String(
          retryAfter
        )
      );

      return res
        .status(429)
        .json({
          error:
            'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.'
        });
    }

    let secrets =
      await readSecrets();

    if (
      verifyPassword(
        'admin123',
        secrets
          .adminPasswordHash
      )
    ) {
      const migrationPassword =
        String(
          process.env
            .ADMIN_PASSWORD ||
          ''
        );

      if (
        migrationPassword
          .length < 12
      ) {
        return res
          .status(503)
          .json({
            error:
              'A senha inicial antiga foi desativada. Defina ADMIN_PASSWORD com pelo menos 12 caracteres no ambiente.'
          });
      }

      secrets =
        await updateSecrets({
          adminPassword:
            migrationPassword
        });
    }

    const expectedUser =
      process.env
        .ADMIN_USER ||
      secrets.adminUser;

    const userOk =
      String(
        req.body.username ||
        ''
      ) === expectedUser;

    const password =
      String(
        req.body.password ||
        ''
      );

    const environmentPassword =
      String(
        process.env
          .ADMIN_PASSWORD ||
        ''
      );

    if (
      !secrets
        .adminPasswordHash &&
      environmentPassword
        .length < 12
    ) {
      return res
        .status(503)
        .json({
          error:
            'Defina ADMIN_PASSWORD com pelo menos 12 caracteres antes do primeiro acesso.'
        });
    }

    const passOk =
      secrets
        .adminPasswordHash
        ? verifyPassword(
            password,
            secrets
              .adminPasswordHash
          )
        : (
            environmentPassword &&
            password.length ===
            environmentPassword.length &&
            crypto.timingSafeEqual(
              Buffer.from(
                password
              ),
              Buffer.from(
                environmentPassword
              )
            )
          );

    if (
      !userOk ||
      !passOk
    ) {
      registerFailedLogin(
        clientIp
      );

      return res
        .status(401)
        .json({
          error:
            'Usuário ou senha incorretos.'
        });
    }

    loginAttempts.delete(
      clientIp
    );

    res.json({
      token:
        createToken(
          expectedUser,
          secrets
            .adminSessionVersion
        )
    });
  }
);

/*
 * ==========================================================
 * DASHBOARD / CONFIG
 * ==========================================================
 */

function adminQueueItem(item = {}) {
  return {
    id: String(item.id || ''),
    kind: String(item.kind || 'offer'),
    offerId: item.offerId || null,
    couponId: item.couponId || null,
    offerTitle: String(item.offerTitle || ''),
    store: String(item.store || ''),
    targetAudienceCodes: Array.isArray(item.targetAudienceCodes) ? item.targetAudienceCodes : [],
    status: String(item.status || 'pending'),
    attempts: Number(item.attempts || 0),
    createdAt: item.createdAt || null,
    sentAt: item.sentAt || null,
    error: item.error || null,
    force: Boolean(item.force)
  };
}

app.get(
  '/api/admin/dashboard',
  requireAdmin,
  async (
    req,
    res
  ) => {
    const data =
      await readStore();

    const secrets =
      await readSecrets();

    const lastSeen =
      data.meta.whatsapp
        ?.lastSeenAt
        ? new Date(
            data.meta
              .whatsapp
              .lastSeenAt
          ).getTime()
        : 0;

    if (
      Date.now() -
      lastSeen >
      90_000 &&
      data.meta
        .whatsapp
        ?.status ===
      'connected'
    ) {
      data.meta
        .whatsapp
        .status =
        'offline';
    }

    res.json({
      ...data,
      offers: (Array.isArray(data.offers) ? data.offers : []).map((offer) => {
        const quality = offerQuality(offer, data.config);
        return {
          ...offer,
          publicSlug: offerPublicSlug(offer),
          qualityScore: quality.score,
          qualityIssues: quality.issues,
          isStale: !offerIsFresh(offer, data.config)
        };
      }),
      queue: (Array.isArray(data.queue) ? data.queue : []).map(adminQueueItem),
      coupons: (Array.isArray(data.coupons) ? data.coupons : []).map((coupon) => ({
        ...coupon,
        shortCode: couponShortCode(coupon),
        shortUrl: couponShortUrl(coupon, req)
      })),

      analytics:
        summarizeAnalytics(
          data.analytics
        ),

      systemHealth:
        summarizeSystemHealth(
          data
        ),

      secrets:
        secretStatus(
          secrets
        )
    });
  }
);

app.put(
  '/api/admin/config',
  requireAdmin,
  async (
    req,
    res
  ) => {
    const body =
      req.body &&
      typeof req.body === 'object' &&
      !Array.isArray(req.body)
        ? req.body
        : {};

    await updateStore(
      (data) => {
        const previousConfig = { ...data.config };
        const previousAudiences =
          Array.isArray(data.config.whatsappAudiences)
            ? data.config.whatsappAudiences
            : [];

        const writingStyleChanged =
          (
            Object.prototype.hasOwnProperty.call(body, 'aiTone') &&
            body.aiTone !==
            data.config.aiTone
          ) ||
          (
            Object.prototype.hasOwnProperty.call(body, 'aiInstructions') &&
            body.aiInstructions !==
            data.config
              .aiInstructions
          ) ||
          (
            Object.prototype.hasOwnProperty.call(body, 'messageTemplate') &&
            body.messageTemplate !==
            data.config
              .messageTemplate
          );

        const audienceRoutingChanged =
          Object.prototype.hasOwnProperty.call(body, 'whatsappAudiences') &&
          JSON.stringify(previousAudiences) !==
          JSON.stringify(body.whatsappAudiences);

        data.config = {
          ...data.config,
          ...body
        };

        if (Object.prototype.hasOwnProperty.call(body, 'whatsappAudiences')) {
          const sanitizedAudiences = sanitizeWhatsappAudiences(body.whatsappAudiences);
          data.config.whatsappAudiences = sanitizedAudiences.length
            ? sanitizedAudiences
            : previousAudiences;
        }

        const numericRules = {
          publicOfferPageSize: [24, 6, 60],
          publicOfferMaxAgeDays: [45, 1, 365],
          rankingDiscountWeight: [35, 0, 100],
          rankingFreshnessWeight: [25, 0, 100],
          rankingQualityWeight: [25, 0, 100],
          rankingClicksWeight: [15, 0, 100],
          qualityMinimumScore: [55, 0, 100],
          qualityMaxTitleLength: [180, 40, 500],
          linkCheckBatchSize: [20, 1, 50],
          analyticsVisitorRetentionDays: [365, 1, 730],
          analyticsDailyRetentionDays: [120, 7, 730],
          contactRetentionMonths: [12, 1, 60],
          consentReceiptRetentionYears: [5, 1, 10],
          legalResponseBusinessDays: [5, 1, 30],
          legalContactRetentionMonths: [12, 1, 60],
          legalConsentRetentionYears: [5, 1, 10],
          monitoringWhatsappMinutes: [5, 1, 120],
          monitoringCollectionHours: [6, 1, 168],
          monitoringFailedQueueLimit: [10, 1, 500],
          extensionMaxCouponsPerRequest: [10, 1, 50],
          instagramIntervalMinutes: [20, 1, 1440],
          instagramMaxPerDay: [15, 1, 1500],
          instagramMinimumDiscount: [20, 0, 99],
          instagramDuplicateDays: [7, 1, 365],
          instagramAssetRetentionHours: [72, 24, 720]
        };
        for (const [key, [fallback, minimum, maximum]] of Object.entries(numericRules)) {
          data.config[key] = boundedNumber(data.config[key], fallback, minimum, maximum);
        }
        if (!/^\d{4}-\d{2}-\d{2}(?:-v\d+)?$/.test(String(data.config.legalPolicyVersion || ''))) {
          data.config.legalPolicyVersion = previousConfig.legalPolicyVersion || privacyPolicyVersion;
        }
        try {
          const canonical = new URL(String(data.config.canonicalUrl || ''));
          if (canonical.protocol !== 'https:') throw new Error('invalid');
          data.config.canonicalUrl = canonical.origin;
        } catch {
          data.config.canonicalUrl = previousConfig.canonicalUrl || '';
        }
        for (const key of ['brandName', 'heroTitle', 'heroText', 'disclosure', 'contactEmail', 'seoSiteName', 'seoTitle', 'seoDescription', 'seoKeywords', 'seoImageUrl', 'affiliateDisclosureLabel', 'qualityBlockedTerms', 'monitoringEmail', 'legalResponsibleName', 'legalResponsibleType', 'legalCityState', 'legalPrivacyEmail', 'legalAffiliatePrograms', 'legalAboutCustomText', 'legalContactCustomText', 'legalTermsCustomText', 'legalPrivacyCustomText', 'searchConsoleSiteUrl', 'searchConsoleRedirectUri']) {
          const maximum = key.endsWith('CustomText') ? 3000 : key === 'heroText' || key === 'disclosure' || key === 'seoDescription' ? 1000 : 300;
          data.config[key] = String(data.config[key] || '').trim().slice(0, maximum);
        }
        if (!/^https:\/\//i.test(data.config.searchConsoleRedirectUri)) data.config.searchConsoleRedirectUri = previousConfig.searchConsoleRedirectUri || '';
        if (!/^(?:sc-domain:|https?:\/\/)/i.test(data.config.searchConsoleSiteUrl)) data.config.searchConsoleSiteUrl = previousConfig.searchConsoleSiteUrl || '';

        if (Object.prototype.hasOwnProperty.call(body, 'instagramThemes')) {
          data.config.instagramThemes = sanitizeInstagramThemes(body.instagramThemes);
        }
        data.config.instagramStores = Array.isArray(data.config.instagramStores)
          ? [...new Set(data.config.instagramStores.map((entry) => String(entry).trim()).filter(Boolean))]
          : previousConfig.instagramStores || [];
        data.config.instagramAudienceCodes = Array.isArray(data.config.instagramAudienceCodes)
          ? [...new Set(data.config.instagramAudienceCodes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))]
          : previousConfig.instagramAudienceCodes || [];
        data.config.extensionStores = Array.isArray(data.config.extensionStores)
          ? [...new Set(data.config.extensionStores.map((entry) => String(entry).trim()).filter((entry) => ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'].includes(entry)))]
          : previousConfig.extensionStores || ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'];
        data.config.extensionAudienceCodes = Array.isArray(data.config.extensionAudienceCodes)
          ? [...new Set(data.config.extensionAudienceCodes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))]
          : previousConfig.extensionAudienceCodes || ['G01'];
        data.config.extensionEnabled = data.config.extensionEnabled !== false;
        data.config.extensionAutoApprove = data.config.extensionAutoApprove === true;
        if (!['automatic', 'manual'].includes(data.config.instagramThemeMode)) data.config.instagramThemeMode = 'automatic';
        if (!/^v\d+\.\d+$/.test(String(data.config.instagramApiVersion || ''))) data.config.instagramApiVersion = previousConfig.instagramApiVersion || 'v25.0';
        for (const key of ['instagramRedirectUri', 'instagramCtaText', 'instagramDisclosureText']) {
          data.config[key] = String(data.config[key] || '').trim().slice(0, 300);
        }
        if (!/^https:\/\//i.test(data.config.instagramRedirectUri)) data.config.instagramRedirectUri = previousConfig.instagramRedirectUri || '';
        for (const key of ['instagramPublishingStart', 'instagramPublishingEnd']) {
          if (!/^\d{2}:\d{2}$/.test(String(data.config[key] || ''))) data.config[key] = previousConfig[key];
        }

        if (audienceRoutingChanged) {
          for (const offer of data.offers) {
            offer.targetAudienceCodes = getAudienceCodesForOffer(
              offer,
              data.config.whatsappAudiences
            );
          }

          for (const item of data.queue) {
            if (item.status !== 'pending') continue;
            const offer = data.offers.find((entry) => entry.id === item.offerId) || item.offerSnapshot;
            const targetAudienceCodes = offer
              ? getAudienceCodesForOffer(offer, data.config.whatsappAudiences)
              : [];
            item.targetAudienceCodes = targetAudienceCodes;
            if (item.offerSnapshot) item.offerSnapshot.targetAudienceCodes = targetAudienceCodes;
            delete item.roundId;
            delete item.roundAudienceCode;
          }

          data.meta.publicationRound = null;
        }

        if (
          writingStyleChanged
        ) {
          for (
            const item
            of data.queue
          ) {
            if (
              item.status !==
              'pending'
            ) {
              continue;
            }

            delete item.aiStatus;
            delete item.aiError;
            delete item.aiGeneratedAt;
            delete item.aiGenerationVersion;
            delete item.aiRetryAt;

            item.message = '';

            item.messageSource =
              'awaiting-ai';
          }
        }
      }
    );

    await addLog(
      'Configurações atualizadas.',
      'success'
    );

    res.json({
      ok: true
    });
  }
);

app.put(
  '/api/admin/secrets',
  requireAdmin,
  async (
    req,
    res
  ) => {
    if (
      req.body
        ?.adminPassword &&
      String(
        req.body
          .adminPassword
      ).length < 12
    ) {
      return res
        .status(400)
        .json({
          error:
            'A nova senha deve ter pelo menos 12 caracteres.'
        });
    }

    const updated =
      await updateSecrets(
        req.body || {}
      );

    await addLog(
      'Credenciais protegidas foram atualizadas.',
      'success'
    );

    res.json(
      secretStatus(
        updated
      )
    );
  }
);

/*
 * ==========================================================
 * MERCADO LIVRE
 * ==========================================================
 */

app.post(
  '/api/admin/sources/mercadolivre/connect',
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const configured =
        String(
          req.body
            .redirectUri ||
          ''
        ).trim();

      const fallbackOrigin =
        String(
          process.env
            .RENDER_EXTERNAL_URL ||
          process.env
            .SITE_URL ||
          ''
        )
          .split(',')[0]
          .replace(
            /\/$/,
            ''
          );

      const redirectUri =
        configured ||
        (
          fallbackOrigin
            ? `${fallbackOrigin}/api/mercadolivre/callback`
            : ''
        );

      let parsed;

      try {
        parsed =
          new URL(
            redirectUri
          );
      } catch {
        parsed = null;
      }

      if (
        !parsed ||
        parsed.protocol !==
        'https:' ||
        parsed.pathname !==
        '/api/mercadolivre/callback' ||
        parsed.search ||
        parsed.hash
      ) {
        return res
          .status(400)
          .json({
            error:
              'Informe uma URL HTTPS terminada exatamente em /api/mercadolivre/callback.'
          });
      }

      const authorizationUrl =
        await beginMercadoLivreAuthorization(
          redirectUri
        );

      res.json({
        ok: true,
        authorizationUrl,
        redirectUri
      });
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            error.message
        });
    }
  }
);

app.get(
  '/api/mercadolivre/callback',
  async (
    req,
    res
  ) => {
    if (
      req.query.error
    ) {
      await addLog(
        `Mercado Livre: autorização cancelada (${String(req.query.error).slice(0, 100)}).`,
        'error'
      );

      return res.redirect(
        '/admin?mercadolivre=cancelled'
      );
    }

    try {
      await finishMercadoLivreAuthorization({
        code:
          String(
            req.query.code ||
            ''
          ),

        state:
          String(
            req.query.state ||
            ''
          )
      });

      await addLog(
        'Conta do Mercado Livre conectada e renovação automática ativada.',
        'success'
      );

      res.redirect(
        '/admin?mercadolivre=connected'
      );
    } catch (error) {
      await addLog(
        `Mercado Livre: falha na autorização (${error.message}).`,
        'error'
      );

      res.redirect(
        '/admin?mercadolivre=error'
      );
    }
  }
);

app.post(
  '/api/admin/sources/mercadolivre/test',
  requireAdmin,
  async (
    _req,
    res
  ) => {
    try {
      const user =
        await validateMercadoLivreConnection();

      const {
        config
      } =
        await readStore();

      const offers =
        await collectMercadoLivre(
          {
            ...config,

            enableMercadoLivre:
              true
          },
          await readSecrets()
        );

      res.json({
        ok: true,

        userId:
          user.id,

        nickname:
          user.nickname ||
          '',

        count:
          offers.length,

        sample:
          offers[0]
            ?.title ||
          null
      });
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            `Mercado Livre: ${error.message}`
        });
    }
  }
);

/*
 * ==========================================================
 * OFERTAS
 * ==========================================================
 */

app.post(
  '/api/admin/offers',
  requireAdmin,
  async (
    req,
    res
  ) => {
    const offer = {
      ...req.body,

      id:
        createId(
          'offer'
        ),

      price:
        Number(
          req.body.price
        ),

      originalPrice:
        Number(
          req.body
            .originalPrice ||
          0
        ),

      createdAt:
        new Date()
          .toISOString(),

      updatedAt:
        new Date()
          .toISOString(),

      source:
        'manual'
    };

    if (
      !offer.title ||
      !offer.price ||
      !offer.affiliateUrl
    ) {
      return res
        .status(400)
        .json({
          error:
            'Produto, preço e link são obrigatórios.'
        });
    }

    await updateStore(
      (data) => {
        offer.targetAudienceCodes =
          getAudienceCodesForOffer(
            offer,
            data.config
              .whatsappAudiences
          );

        data.offers.unshift(
          offer
        );
      }
    );

    await addLog(
      `Oferta adicionada: ${offer.title} → ${offer.targetAudienceCodes.join(', ') || 'nenhum grupo'}`,
      'success'
    );

    res
      .status(201)
      .json(
        offer
      );
  }
);

app.post(
  '/api/admin/search-products',
  requireAdmin,
  async (
    req,
    res
  ) => {
    const query =
      String(
        req.body.query ||
        ''
      ).trim();

    const stores =
      Array.isArray(
        req.body.stores
      )
        ? req.body.stores
        : [];

    const requestedLimit =
      req.body.limit;

    const strictSearch = req.body.strict !== false;

    const limit =
      requestedLimit ===
      'all'
        ? 100
        : Math.min(
            Math.max(
              Number(
                requestedLimit
              ) || 10,
              1
            ),
            100
          );

    if (!query) {
      return res
        .status(400)
        .json({
          error:
            'Digite o nome do produto que deseja buscar.'
        });
    }

    const selectedStores =
      stores.length
        ? stores
        : [
            'mercadolivre',
            'shopee'
          ];

    const secrets =
      await readSecrets();

    const { config } = await readStore();

    const results = [];
    const errors = [];

    if (
      selectedStores.includes(
        'mercadolivre'
      )
    ) {
      try {
        const mercadoLivreResults =
          await searchMercadoLivreProducts(
            query,
            Math.max(limit, 20)
          );

        results.push(
          ...mercadoLivreResults
        );
      } catch (error) {
        errors.push(
          `Mercado Livre: ${error.message}`
        );
      }
    }

    if (
      selectedStores.includes(
        'shopee'
      )
    ) {
      try {
        const shopeeResults =
          await searchShopeeProducts(
            query,
            secrets,
            Math.max(limit * 4, 40)
          );

        results.push(
          ...shopeeResults
        );
      } catch (error) {
        errors.push(
          `Shopee: ${error.message}`
        );
      }
    }

    let magaluStoreUrl = '';
    if (selectedStores.includes('magalu')) {
      const slug = String(
        config.magaluStoreSlug ||
        (String(secrets.magaluAffiliateId || '').toLowerCase().includes('magazine') ? secrets.magaluAffiliateId : '') ||
        'magazinepromoshopsite'
      ).trim().replace(/^\/+|\/+$/g, '');
      magaluStoreUrl = `https://www.magazinevoce.com.br/${encodeURIComponent(slug)}/busca/?q=${encodeURIComponent(query)}`;
      errors.push('Magalu: a vitrine pode exigir captcha e não libera uma busca automática confiável. Abra a busca da sua loja e cadastre o link do produto no formulário abaixo.');
    }

    const rankedResults = rankProductSearchResults(query, results, { strict: strictSearch, limitPerStore: limit });
    const countByStore = (items) => items.reduce((counts, item) => {
      const store = String(item.store || 'Outra loja');
      counts[store] = (counts[store] || 0) + 1;
      return counts;
    }, {});

    res.json({
      query,

      count:
        rankedResults.length,

      results: rankedResults,
      discarded: Math.max(0, results.length - rankedResults.length),
      sourceCounts: countByStore(results),
      visibleCounts: countByStore(rankedResults),
      strict: strictSearch,
      errors,
      magaluStoreUrl
    });
  }
);

app.put(
  '/api/admin/offers/:id',
  requireAdmin,
  async (
    req,
    res
  ) => {
    let updated;
    let found = false;
    let validationError = '';

    await updateStore(
      (data) => {
        const offer =
          data.offers.find(
            (item) =>
              item.id ===
              req.params.id
          );

        if (!offer) {
          return;
        }

        found = true;

        const allowed = [
          'title',
          'store',
          'category',
          'price',
          'originalPrice',
          'image',
          'affiliateUrl',
          'freeShipping',
          'featured',
          'status'
        ];

        const candidate = { ...offer };

        for (
          const key
          of allowed
        ) {
          if (
            key in req.body
          ) {
            candidate[key] =
              req.body[key];
          }
        }

        candidate.title = String(candidate.title || '').trim().slice(0, 300);
        candidate.store = String(candidate.store || 'Outra').trim().slice(0, 80);
        candidate.category = String(candidate.category || '').trim().slice(0, 100);
        candidate.price = Number(candidate.price || 0);
        candidate.originalPrice = Number(candidate.originalPrice || 0);
        candidate.image = String(candidate.image || '').trim().slice(0, 2000);
        candidate.affiliateUrl = String(candidate.affiliateUrl || '').trim().slice(0, 3000);
        candidate.freeShipping = Boolean(candidate.freeShipping);
        candidate.featured = Boolean(candidate.featured);

        if (!candidate.title || !(candidate.price > 0) || !/^https:\/\//i.test(candidate.affiliateUrl)) {
          validationError = 'Produto, preço válido e link HTTPS são obrigatórios.';
          return;
        }

        candidate.targetAudienceCodes =
          getAudienceCodesForOffer(
            candidate,
            data.config
              .whatsappAudiences
          );

        candidate.updatedAt =
          new Date()
            .toISOString();

        Object.assign(offer, candidate);
        updated = { ...offer };
      }
    );

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (!found) {
      return res
        .status(404)
        .json({
          error:
            'Oferta não encontrada.'
        });
    }

    await addLog(
      `Oferta atualizada: ${updated.title}`,
      'success'
    );

    res.json(
      updated
    );
  }
);

app.delete(
  '/api/admin/offers/:id',
  requireAdmin,
  async (
    req,
    res
  ) => {
    await updateStore(
      (data) => {
        data.offers =
          data.offers.filter(
            (offer) =>
              offer.id !==
              req.params.id
          );
      }
    );

    await addLog(
      'Oferta removida.'
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  '/api/admin/offers/bulk-queue',
  requireAdmin,
  async (req, res) => {
    const mode = String(req.body?.mode || 'all') === 'missing' ? 'missing' : 'all';
    let queued = 0;
    let skippedPending = 0;
    let skippedHistory = 0;
    let skippedInvalid = 0;
    let skippedNoAudience = 0;

    await updateStore((data) => {
      data.queue ||= [];
      const activeOffers = (data.offers || []).filter((offer) => offer.status === 'active');
      for (const offer of activeOffers) {
        if (!offer.title || !offer.affiliateUrl || !(Number(offer.price) > 0)) {
          skippedInvalid += 1;
          continue;
        }

        const history = data.queue.filter((item) => item.offerId === offer.id);
        if (mode === 'missing' && history.length) {
          skippedHistory += 1;
          continue;
        }
        if (mode === 'all' && history.some((item) => ['pending', 'publishing'].includes(item.status))) {
          skippedPending += 1;
          continue;
        }

        const queueItem = makeQueueItem(offer, data.config);
        if (!Array.isArray(queueItem.targetAudienceCodes) || !queueItem.targetAudienceCodes.length) {
          skippedNoAudience += 1;
          continue;
        }
        data.queue.push(queueItem);
        queued += 1;
      }
    });

    if (queued) {
      await addLog(
        `${queued} oferta(s) ${mode === 'missing' ? 'recente(s) fora da fila' : 'ativa(s)'} agendada(s) em lote.`,
        'success'
      );
    }
    res.json({ ok: true, mode, queued, skippedPending, skippedHistory, skippedInvalid, skippedNoAudience });
  }
);

app.post(
  '/api/admin/offers/:id/queue',
  requireAdmin,
  async (
    req,
    res
  ) => {
    let queueItem;

    await updateStore(
      (data) => {
        const offer =
          data.offers.find(
            (item) =>
              item.id ===
              req.params.id
          );

        if (!offer) {
          return;
        }

        if (
          offer.status !==
          'active'
        ) {
          return;
        }

        queueItem = {
          ...makeQueueItem(
            offer,
            data.config
          ),

          force:
            Boolean(
              req.body.force
            )
        };

        data.queue.push(
          queueItem
        );
      }
    );

    if (!queueItem) {
      return res
        .status(400)
        .json({
          error:
            'A oferta precisa ter um link afiliado confirmado antes do envio.'
        });
    }

    await addLog(
      `${queueItem.force ? 'Publicação forçada' : 'Oferta enviada para a fila'}: ${queueItem.offerTitle}`,
      queueItem.force
        ? 'success'
        : 'info'
    );

    res
      .status(201)
      .json(
        queueItem
      );
  }
);

async function googleSearchConsoleAccessToken(secrets) {
  const now = Date.now();
  if (secrets.googleSearchConsoleAccessToken && Number(secrets.googleSearchConsoleTokenExpiresAt || 0) > now + 60_000) return secrets.googleSearchConsoleAccessToken;
  if (!secrets.googleSearchConsoleRefreshToken) throw new Error('Conecte sua conta Google primeiro.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: secrets.googleSearchConsoleClientId, client_secret: secrets.googleSearchConsoleClientSecret, refresh_token: secrets.googleSearchConsoleRefreshToken, grant_type: 'refresh_token' })
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(body.error_description || 'O Google não renovou o acesso ao Search Console.');
  await updateSecrets({ googleSearchConsoleAccessToken: body.access_token, googleSearchConsoleTokenExpiresAt: now + Number(body.expires_in || 3600) * 1000 });
  return body.access_token;
}

app.post('/api/admin/search-console/connect', requireAdmin, async (req, res) => {
  const [{ config }, secrets] = await Promise.all([readStore(), readSecrets()]);
  if (!secrets.googleSearchConsoleClientId || !secrets.googleSearchConsoleClientSecret) return res.status(400).json({ error: 'Informe o ID do cliente e a chave secreta do Google.' });
  const redirectUri = String(config.searchConsoleRedirectUri || '').trim();
  if (!/^https:\/\//i.test(redirectUri)) return res.status(400).json({ error: 'Configure uma URL de retorno HTTPS para o Search Console.' });
  const state = crypto.randomBytes(24).toString('hex');
  await updateSecrets({ googleSearchConsoleOAuthState: state });
  const params = new URLSearchParams({ client_id: secrets.googleSearchConsoleClientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/webmasters.readonly', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  res.json({ authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/api/search-console/callback', async (req, res) => {
  const [{ config }, secrets] = await Promise.all([readStore(), readSecrets()]);
  const adminUrl = `${String(config.canonicalUrl || '').replace(/\/+$/, '')}/admin`;
  if (!req.query.code || !req.query.state || req.query.state !== secrets.googleSearchConsoleOAuthState) return res.redirect(`${adminUrl}?searchconsole=error`);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: secrets.googleSearchConsoleClientId, client_secret: secrets.googleSearchConsoleClientSecret, code: String(req.query.code), redirect_uri: String(config.searchConsoleRedirectUri), grant_type: 'authorization_code' }) });
    const body = await response.json();
    if (!response.ok || !body.access_token) throw new Error(body.error_description || 'Falha ao autorizar.');
    await updateSecrets({ googleSearchConsoleAccessToken: body.access_token, googleSearchConsoleRefreshToken: body.refresh_token || secrets.googleSearchConsoleRefreshToken, googleSearchConsoleTokenExpiresAt: Date.now() + Number(body.expires_in || 3600) * 1000, googleSearchConsoleOAuthState: '' });
    await addLog('Google Search Console conectado.', 'success');
    res.redirect(`${adminUrl}?searchconsole=connected`);
  } catch (error) {
    await addLog(`Falha ao conectar Search Console: ${error.message}`, 'error');
    res.redirect(`${adminUrl}?searchconsole=error`);
  }
});

app.get('/api/admin/search-console/summary', requireAdmin, async (_req, res) => {
  try {
    const [{ config }, secrets] = await Promise.all([readStore(), readSecrets()]);
    const accessToken = await googleSearchConsoleAccessToken(secrets);
    const endDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(config.searchConsoleSiteUrl || 'sc-domain:jhonatafaraujo.com.br')}/searchAnalytics/query`;
    const request = async (dimensions, rowLimit = 20) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Search Console não respondeu.');
      return body.rows || [];
    };
    const [totals, queries, pages] = await Promise.all([request([], 1), request(['query'], 10), request(['page'], 10)]);
    res.json({ period: { startDate, endDate }, totals: totals[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 }, queries, pages });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get(
  '/api/admin/backup',
  requireAdmin,
  async (_req, res) => {
    const data = await readStore();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="promoshop-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      kind: 'promoshop-safe-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      notice: 'Backup operacional sem senhas, chaves de API, sessões do WhatsApp, mensagens de contato, comprovantes de consentimento ou identificadores de audiência.',
      config: data.config,
      coupons: Array.isArray(data.coupons) ? data.coupons : []
    });
  }
);

app.post(
  '/api/admin/backup/restore',
  requireAdmin,
  async (req, res) => {
    const backup = req.body;
    if (!backup || backup.kind !== 'promoshop-safe-backup' || Number(backup.version) !== 1) {
      return res.status(400).json({ error: 'Arquivo de backup inválido ou incompatível.' });
    }

    await updateStore((data) => {
      if (backup.config && typeof backup.config === 'object' && !Array.isArray(backup.config)) {
        const allowedKeys = new Set(Object.keys(data.config || {}));
        const restoredConfig = Object.fromEntries(Object.entries(backup.config).filter(([key]) => allowedKeys.has(key)));
        data.config = { ...data.config, ...restoredConfig };
      }
      if (Array.isArray(backup.coupons)) {
        data.coupons = backup.coupons.filter((coupon) => coupon && typeof coupon === 'object' && coupon.id && coupon.title && coupon.link).slice(0, 300);
      }
    });

    await addLog('Backup operacional restaurado pelo painel.', 'success');
    return res.json({ ok: true });
  }
);

app.post(
  '/api/admin/maintenance/check-links',
  requireAdmin,
  async (_req, res) => {
    return res.json(await runOfferLinkChecks());
  }
);

app.post('/api/admin/extension/token', requireAdmin, async (_req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  await updateSecrets({ extensionIngestToken: token });
  await addLog('Token da extensão de cupons gerado.', 'success');
  res.json({ ok: true, token });
});

app.delete('/api/admin/extension/token', requireAdmin, async (_req, res) => {
  await updateSecrets({ clearExtensionIngestToken: true });
  await addLog('Token da extensão de cupons revogado.', 'warning');
  res.json({ ok: true });
});

/*
 * ==========================================================
 * INSTAGRAM STORIES
 * ==========================================================
 */

app.post('/api/admin/instagram/connect', requireAdmin, async (req, res) => {
  try {
    const [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const authorizationUrl = await beginInstagramAuthorization(data.config, secrets);
    res.json({ authorizationUrl });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/instagram/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const profile = await finishInstagramAuthorization(data.config, secrets, req.query || {});
    await addLog(`Instagram conectado${profile.username ? ` como @${profile.username}` : ''}.`, 'success');
    res.redirect('/admin?instagram=connected');
  } catch (error) {
    await addLog(`Instagram: não foi possível concluir a conexão: ${error.message}`, 'error');
    res.redirect(`/admin?instagram_error=${encodeURIComponent(String(error.message || 'Falha na conexão').slice(0, 180))}`);
  }
});

app.post('/api/instagram/deauthorize', async (req, res) => {
  try {
    const secrets = await readSecrets();
    verifyInstagramSignedRequest(req.body?.signed_request, secrets.instagramAppSecret);
    await updateSecrets({ clearInstagramConnection: true });
    await addLog('Instagram: a Meta desautorizou a integração e o acesso foi removido.', 'warning');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/instagram/data-deletion', async (req, res) => {
  try {
    const secrets = await readSecrets();
    verifyInstagramSignedRequest(req.body?.signed_request, secrets.instagramAppSecret);
    await updateSecrets({ clearInstagramConnection: true });
    const data = await readStore();
    const confirmationCode = crypto.randomBytes(12).toString('hex');
    const canonical = String(data.config.canonicalUrl || '').replace(/\/$/, '');
    await addLog(`Instagram: pedido de exclusão processado (${confirmationCode}).`, 'warning');
    res.json({ url: `${canonical}/exclusao-de-dados?confirmation=${confirmationCode}`, confirmation_code: confirmationCode });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/test', requireAdmin, async (req, res) => {
  try {
    const [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const profile = await testInstagramConnection(data.config, secrets);
    res.json({ ok: true, username: profile.username || '', name: profile.name || '' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/refresh', requireAdmin, async (req, res) => {
  try {
    const secrets = await readSecrets();
    const result = await refreshInstagramToken(secrets);
    await addLog('Instagram: token de acesso renovado.', 'success');
    res.json({ ok: true, expiresIn: Number(result.expires_in || 0) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/disconnect', requireAdmin, async (req, res) => {
  await updateSecrets({ clearInstagramConnection: true });
  await addLog('Instagram desconectado do publicador.', 'warning');
  res.json({ ok: true });
});

app.post('/api/admin/instagram/preview', requireAdmin, async (req, res) => {
  try {
    const data = await readStore();
    const candidate = req.body?.story || (data.offers || []).find((offer) => offer.image && offer.status === 'active') || {
      title: 'Oferta selecionada especialmente para você',
      store: 'PromoShop', price: 99.9, originalPrice: 159.9, discount: 38, image: '', link: data.config.canonicalUrl
    };
    const sample = { ...candidate, link: candidate.link || candidate.affiliateUrl || data.config.canonicalUrl };
    const asset = await generateInstagramStory(sample, data.config, String(req.body?.themeId || ''));
    const canonical = String(data.config.canonicalUrl || '').replace(/\/$/, '');
    res.json({ ok: true, themeId: asset.themeId, imageUrl: `${canonical}/media/instagram/${asset.fileName}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/share-preview', requireAdmin, async (req, res) => {
  try {
    const data = await readStore();
    const kind = req.body?.kind === 'coupon' ? 'coupon' : 'offer';
    const id = String(req.body?.id || '').trim();
    const source = kind === 'coupon'
      ? (data.coupons || []).find((coupon) => String(coupon.id) === id && coupon.active !== false)
      : (data.offers || []).find((offer) => String(offer.id) === id && offer.status !== 'paused');
    if (!source) return res.status(404).json({ error: 'Selecione uma oferta ou cupom ativo.' });

    const sample = kind === 'coupon'
      ? {
        kind: 'coupon',
        title: source.title,
        store: source.store,
        price: 0,
        originalPrice: 0,
        discount: source.discountType === 'percent' ? source.discountValue : 0,
        image: source.image,
        link: source.shortUrl || source.link
      }
      : {
        ...source,
        link: source.affiliateUrl || source.link
      };
    const shareConfig = {
      ...data.config,
      instagramShowQrCode: Boolean(req.body?.showQrCode),
      instagramCtaText: String(req.body?.ctaText || 'Acesse o link da bio').slice(0, 80)
    };
    const asset = await generateInstagramStory({
      ...sample,
      shareProfile: String(req.body?.profile || '').slice(0, 60)
    }, shareConfig, String(req.body?.themeId || ''));
    const canonical = String(data.config.canonicalUrl || '').replace(/\/$/, '');
    res.json({ ok: true, themeId: asset.themeId, imageUrl: `${canonical}/media/instagram/${asset.fileName}`, fileName: asset.fileName });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/share-template', requireAdmin, async (req, res) => {
  try {
    const [data, secrets] = await Promise.all([readStore(), readSecrets()]);
    const templateType = req.body?.templateType === 'group' ? 'group' : req.body?.templateType === 'site' ? 'site' : 'profile';
    const profileMode = req.body?.profileMode === 'none' ? 'none' : req.body?.profileMode === 'auto' ? 'auto' : 'manual';
    const profile = profileMode === 'auto'
      ? String(secrets.instagramUsername || 'sonapromoshop')
      : String(req.body?.profile || '').trim();
    const audience = templateType === 'group'
      ? (data.config.whatsappAudiences || []).find((item) => String(item.code) === String(req.body?.groupCode || '') && item.enabled !== false)
      : null;
    if (templateType === 'group' && !audience) return res.status(404).json({ error: 'Selecione um grupo do WhatsApp ativo.' });
    const asset = await generateInstagramShareTemplate({
      templateType,
      profileMode,
      profile,
      groupName: audience?.name,
      groupCode: audience?.code,
      groupLink: audience?.whatsappLink,
      siteTitle: String(req.body?.siteTitle || '').slice(0, 100),
      siteDescription: String(req.body?.siteDescription || '').slice(0, 300),
      bio: req.body?.bio,
      ctaText: req.body?.ctaText,
      manualLinkPlacement: Boolean(req.body?.manualLinkPlacement),
      showQrCode: Boolean(req.body?.showQrCode)
    }, data.config, String(req.body?.themeId || ''));
    const canonical = String(data.config.canonicalUrl || '').replace(/\/$/, '');
    res.json({ ok: true, themeId: asset.themeId, imageUrl: `${canonical}/media/instagram/${asset.fileName}`, fileName: asset.fileName });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/queue/:id/publish', requireAdmin, async (req, res) => {
  const data = await readStore();
  const item = (data.instagramQueue || []).find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Publicação do Instagram não encontrada.' });
  processInstagramQueue({ forceId: item.id }).catch((error) => console.error('Instagram:', error.message));
  res.status(202).json({ ok: true, message: 'Publicação iniciada. O estado será atualizado no painel.' });
});

app.post('/api/admin/instagram/queue/:id/retry', requireAdmin, async (req, res) => {
  let found = false;
  await updateStore((data) => {
    const item = (data.instagramQueue || []).find((entry) => entry.id === req.params.id);
    if (!item || item.status === 'sent') return;
    found = true;
    Object.assign(item, { status: 'pending', attempts: 0, retryAt: null, error: null, instagramRateLimited: false });
  });
  if (!found) return res.status(404).json({ error: 'Publicação não encontrada ou já enviada.' });
  res.json({ ok: true });
});

app.delete('/api/admin/instagram/queue/:id', requireAdmin, async (req, res) => {
  let removed = false;
  await updateStore((data) => {
    const before = (data.instagramQueue || []).length;
    data.instagramQueue = (data.instagramQueue || []).filter((entry) => entry.id !== req.params.id || entry.status === 'publishing');
    removed = data.instagramQueue.length < before;
  });
  if (!removed) return res.status(400).json({ error: 'Não é possível excluir uma publicação que está sendo enviada.' });
  res.json({ ok: true });
});

app.get('/media/instagram/:fileName', async (req, res) => {
  const filePath = instagramAssetPath(req.params.fileName);
  if (!filePath) return res.status(404).end();
  try {
    await fs.access(filePath);
    res.set('Cache-Control', 'public, max-age=259200');
    res.type('image/jpeg').sendFile(filePath);
  } catch {
    res.status(404).end();
  }
});

/*
 * ==========================================================
 * CUPONS
 * ==========================================================
 */

function parseCouponInput(body = {}, existing = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);
  const pick = (key, fallback = '') => has(key) ? body[key] : (existing[key] ?? fallback);
  const title = String(pick('title')).trim().slice(0, 180);
  const rawLink = String(pick('link')).trim();
  const link = rawLink.slice(0, 10000);
  const description = String(pick('description')).trim().slice(0, 500);
  const code = String(pick('code')).trim().slice(0, 80);
  const store = String(pick('store', 'Magalu')).trim().slice(0, 60) || 'Magalu';
  const discountType = ['percent', 'fixed', 'free-shipping'].includes(pick('discountType'))
    ? pick('discountType')
    : 'percent';
  const rawDiscountValue = Number(pick('discountValue', 0));
  const rawMinPurchase = Number(pick('minPurchase', 0));
  const discountValue = Number.isFinite(rawDiscountValue) ? Math.max(0, rawDiscountValue) : 0;
  const minPurchase = Number.isFinite(rawMinPurchase) ? Math.max(0, rawMinPurchase) : 0;
  const targetAudienceCodes = normalizeCouponAudienceCodes(pick('targetAudienceCodes', []));
  const expiresAtRaw = pick('expiresAt', '');
  const expiresAtDate = expiresAtRaw ? new Date(expiresAtRaw) : null;

  let parsedLink;
  try { parsedLink = new URL(link); } catch { parsedLink = null; }

  if (!title || !parsedLink || !['http:', 'https:'].includes(parsedLink.protocol)) {
    return { error: 'Informe o título e um link HTTPS válido para o cupom.' };
  }
  if (rawLink.length > 10000) {
    return { error: 'O link do cupom é muito longo. Use um endereço com até 10.000 caracteres.' };
  }
  if (!targetAudienceCodes.length) {
    return { error: 'Selecione pelo menos um grupo para este cupom.' };
  }
  if (expiresAtRaw && (!expiresAtDate || Number.isNaN(expiresAtDate.getTime()))) {
    return { error: 'Informe uma validade correta para o cupom.' };
  }

  return {
    fields: {
      title,
      store,
      code,
      description,
      discountType,
      discountValue,
      minPurchase,
      expiresAt: expiresAtDate ? expiresAtDate.toISOString() : null,
      link,
      image: String(pick('image')).trim().slice(0, 1000),
      featured: pick('featured', true) !== false,
      active: pick('active', true) !== false,
      targetAudienceCodes
    }
  };
}

function extensionRequestBody(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function extensionTokenMatches(provided, expected) {
  const left = Buffer.from(String(provided || ''));
  const right = Buffer.from(String(expected || ''));
  return Boolean(right.length) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extensionCouponFingerprint(coupon) {
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const store = normalize(coupon.store);
  const code = normalize(coupon.code);
  const link = String(coupon.link || '').trim().replace(/[?#].*$/, '').toLowerCase();
  return `${store}|${code || link}`;
}

function extensionAllowedStore(config, store) {
  const allowed = Array.isArray(config.extensionStores) ? config.extensionStores.map((entry) => String(entry).toLowerCase()) : ['mercado livre', 'shopee'];
  return allowed.includes(String(store || '').trim().toLowerCase());
}

function extensionValidLink(store, link) {
  try {
    const url = new URL(String(link));
    if (url.protocol !== 'https:') return false;
    const normalizedStore = String(store).toLowerCase();
    const hosts = normalizedStore === 'mercado livre'
      ? ['mercadolivre.com.br', 'mercadolivre.com', 'meli.la']
      : normalizedStore === 'shopee'
        ? ['shopee.com.br', 'shopee.com']
        : normalizedStore === 'aliexpress'
          ? ['aliexpress.com', 'aliexpress.com.br']
          : ['magazineluiza.com.br', 'magalu.com', 'magazinevoce.com.br'];
    return hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

app.post('/api/extension/coupons', async (req, res) => {
  const body = extensionRequestBody(req);
  const secrets = await readSecrets();
  const token = String(body.token || req.headers['x-promoshop-extension-token'] || '').trim();
  if (!extensionTokenMatches(token, secrets.extensionIngestToken)) return res.status(401).json({ error: 'Token da extensão inválido.' });

  const now = Date.now();
  const rateKey = `${req.ip || 'unknown'}:${token.slice(-8)}`;
  const recent = extensionRateLimit.get(rateKey) || [];
  const activeRequests = recent.filter((timestamp) => now - timestamp < 60_000);
  if (activeRequests.length >= 30) return res.status(429).json({ error: 'Muitas importações em pouco tempo. Aguarde um minuto.' });
  activeRequests.push(now);
  extensionRateLimit.set(rateKey, activeRequests);

  const data = await readStore();
  const config = data.config || {};
  if (config.extensionEnabled === false) return res.status(403).json({ error: 'A extensão está desativada no painel.' });
  const incoming = Array.isArray(body.coupons) ? body.coupons : [body];
  const allowDuplicate = body.allowDuplicate === true;
  const maximum = boundedNumber(config.extensionMaxCouponsPerRequest, 10, 1, 50);
  const candidates = incoming.slice(0, maximum);
  const existingFingerprints = new Set((data.coupons || []).map(extensionCouponFingerprint));
  const imported = [];
  const duplicates = [];
  const errors = [];

  await updateStore((storeData) => {
    storeData.coupons ||= [];
    for (const candidate of candidates) {
      const storeName = String(candidate.store || '').trim().slice(0, 60);
      if (!extensionAllowedStore(config, storeName)) { errors.push('Loja não permitida'); continue; }
      const audienceCodes = normalizeCouponAudienceCodes(
        Array.isArray(candidate.targetAudienceCodes) && candidate.targetAudienceCodes.length
          ? candidate.targetAudienceCodes
          : config.extensionAudienceCodes
      );
      const parsed = parseCouponInput({ ...candidate, store: storeName, targetAudienceCodes: audienceCodes, active: config.extensionAutoApprove === true });
      if (parsed.error) { errors.push(parsed.error); continue; }
      if (!extensionValidLink(storeName, parsed.fields.link)) { errors.push('Link não pertence à loja informada.'); continue; }
      const fingerprint = extensionCouponFingerprint(parsed.fields);
      if (existingFingerprints.has(fingerprint)) {
        if (!allowDuplicate) { duplicates.push(parsed.fields.title); continue; }
        const existing = storeData.coupons.find((entry) => extensionCouponFingerprint(entry) === fingerprint);
        if (!existing) { duplicates.push(parsed.fields.title); continue; }
        Object.assign(existing, parsed.fields, {
          source: 'extension',
          approvalStatus: config.extensionAutoApprove === true ? 'approved' : 'pending',
          active: config.extensionAutoApprove === true,
          importedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          shortUrl: couponShortUrl(existing, req)
        });
        imported.push({ id: existing.id, title: existing.title, status: existing.approvalStatus, reimported: true });
        continue;
      }
      existingFingerprints.add(fingerprint);
      const coupon = {
        id: createId('coupon'),
        ...parsed.fields,
        source: 'extension',
        approvalStatus: config.extensionAutoApprove === true ? 'approved' : 'pending',
        importedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      coupon.shortCode = createCouponShortCode(storeData.coupons);
      coupon.shortUrl = couponShortUrl(coupon, req);
      storeData.coupons.unshift(coupon);
      imported.push({ id: coupon.id, title: coupon.title, status: coupon.approvalStatus });
    }
    storeData.coupons = storeData.coupons.slice(0, 300);
  });

  if (imported.length) await addLog(`Extensão: ${imported.length} cupom(ns) recebido(s)${config.extensionAutoApprove === true ? ' e aprovado(s)' : ' para revisão'}.`, 'success');
  res.status(imported.length || duplicates.length ? 202 : 400).json({ ok: imported.length > 0, imported, duplicates, errors: errors.slice(0, 10) });
});

app.post(
  '/api/admin/coupons',
  requireAdmin,
  async (req, res) => {
    const parsed = parseCouponInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let coupon = {
      id: createId('coupon'),
      ...parsed.fields,
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await updateStore((data) => {
      data.coupons ||= [];
      coupon.shortCode = createCouponShortCode(data.coupons);
      coupon.shortUrl = couponShortUrl(coupon, req);
      data.coupons.unshift(coupon);
      data.coupons = data.coupons.slice(0, 300);
    });

    await addLog(`Cupom cadastrado: ${coupon.title} → ${coupon.targetAudienceCodes.join(', ')}`, 'success');
    return res.status(201).json(coupon);
  }
);

app.put(
  '/api/admin/coupons/:id',
  requireAdmin,
  async (req, res) => {
    let updated;
    let validationError = '';

    await updateStore((data) => {
      data.coupons ||= [];
      const coupon = data.coupons.find((entry) => entry.id === req.params.id);
      if (!coupon) return;

      const parsed = parseCouponInput(req.body, coupon);
      if (parsed.error) {
        validationError = parsed.error;
        return;
      }

      if (!coupon.shortCode) coupon.shortCode = createCouponShortCode(data.coupons);
      Object.assign(coupon, parsed.fields, { shortUrl: couponShortUrl(coupon, req), updatedAt: new Date().toISOString() });
      data.queue ||= [];
      if (coupon.active === false) {
        data.queue = data.queue.filter((item) => !(item.kind === 'coupon' && item.couponId === coupon.id && item.status === 'pending'));
      } else {
        const targetAudienceCodes = normalizeCouponAudienceCodes(coupon.targetAudienceCodes);
        data.queue.forEach((item) => {
          if (item.kind !== 'coupon' || item.couponId !== coupon.id || item.status !== 'pending') return;
          item.offerTitle = coupon.title;
          item.store = coupon.store || 'Magalu';
          item.targetAudienceCodes = targetAudienceCodes;
          item.couponSnapshot = { ...coupon, targetAudienceCodes, shortUrl: couponShortUrl(coupon, req) };
          item.message = formatCouponMessage({ ...coupon, shortUrl: couponShortUrl(coupon, req) });
          item.image = coupon.image || '';
        });
      }
      updated = { ...coupon };
    });

    if (validationError) return res.status(400).json({ error: validationError });
    if (!updated) return res.status(404).json({ error: 'Cupom não encontrado.' });

    await addLog(`Cupom atualizado: ${updated.title} → ${updated.targetAudienceCodes.join(', ')}`, 'success');
    return res.json(updated);
  }
);

app.post('/api/admin/extension/coupons/:id/approve', requireAdmin, async (req, res) => {
  let updated = null;
  await updateStore((data) => {
    const coupon = (data.coupons || []).find((entry) => entry.id === req.params.id && entry.source === 'extension');
    if (!coupon) return;
    coupon.active = true;
    coupon.approvalStatus = 'approved';
    coupon.updatedAt = new Date().toISOString();
    updated = { ...coupon };
  });
  if (!updated) return res.status(404).json({ error: 'Cupom da extensão não encontrado.' });
  await addLog(`Cupom importado aprovado: ${updated.title}.`, 'success');
  res.json({ ok: true, coupon: updated });
});

app.post('/api/admin/extension/coupons/approve-all', requireAdmin, async (_req, res) => {
  let approved = 0;
  await updateStore((data) => {
    for (const coupon of data.coupons || []) {
      if (coupon.source !== 'extension' || coupon.approvalStatus !== 'pending') continue;
      coupon.active = true;
      coupon.approvalStatus = 'approved';
      coupon.updatedAt = new Date().toISOString();
      approved += 1;
    }
  });
  if (approved) await addLog(`${approved} cupom(ns) importado(s) aprovado(s) em lote.`, 'success');
  res.json({ ok: true, approved });
});

app.post('/api/admin/extension/coupons/reject-all', requireAdmin, async (_req, res) => {
  let rejected = 0;
  await updateStore((data) => {
    for (const coupon of data.coupons || []) {
      if (coupon.source !== 'extension' || coupon.approvalStatus !== 'pending') continue;
      coupon.active = false;
      coupon.approvalStatus = 'rejected';
      coupon.updatedAt = new Date().toISOString();
      rejected += 1;
    }
  });
  if (rejected) await addLog(`${rejected} cupom(ns) importado(s) recusado(s) em lote.`, 'info');
  res.json({ ok: true, rejected });
});

app.post('/api/admin/extension/coupons/:id/reject', requireAdmin, async (req, res) => {
  let updated = null;
  await updateStore((data) => {
    const coupon = (data.coupons || []).find((entry) => entry.id === req.params.id && entry.source === 'extension');
    if (!coupon) return;
    coupon.active = false;
    coupon.approvalStatus = 'rejected';
    coupon.updatedAt = new Date().toISOString();
    updated = { ...coupon };
  });
  if (!updated) return res.status(404).json({ error: 'Cupom da extensão não encontrado.' });
  await addLog(`Cupom importado recusado: ${updated.title}.`, 'info');
  res.json({ ok: true, coupon: updated });
});

app.post('/api/admin/offers/bulk', requireAdmin, async (req, res) => {
  const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 200));
  const action = String(req.body?.action || '');
  if (!ids.size || !['pause', 'activate'].includes(action)) return res.status(400).json({ error: 'Seleção ou ação inválida.' });
  let updated = 0;
  await updateStore((data) => {
    for (const offer of data.offers || []) {
      if (!ids.has(String(offer.id))) continue;
      if (action === 'activate' && !/^https:\/\//i.test(String(offer.affiliateUrl || '').trim())) continue;
      offer.status = action === 'activate' ? 'active' : 'paused';
      offer.updatedAt = new Date().toISOString();
      updated += 1;
    }
  });
  await addLog(`${updated} oferta(s) ${action === 'activate' ? 'ativadas' : 'pausadas'} na revisão.`, 'success');
  res.json({ ok: true, updated });
});

app.delete(
  '/api/admin/coupons/:id',
  requireAdmin,
  async (req, res) => {
    let removed = false;
    await updateStore((data) => {
      data.coupons ||= [];
      const before = data.coupons.length;
      data.coupons = data.coupons.filter((coupon) => coupon.id !== req.params.id);
      removed = data.coupons.length !== before;
      data.queue = data.queue.filter((item) => !(item.kind === 'coupon' && item.couponId === req.params.id && item.status === 'pending'));
    });
    if (!removed) return res.status(404).json({ error: 'Cupom não encontrado.' });
    await addLog('Cupom removido.', 'info');
    return res.json({ ok: true });
  }
);

app.post(
  '/api/admin/coupons/:id/queue',
  requireAdmin,
  async (req, res) => {
    let queueItem;
    await updateStore((data) => {
      const coupon = (data.coupons || []).find((entry) => entry.id === req.params.id);
      if (!coupon || coupon.active === false) return;
      const targetAudienceCodes = normalizeCouponAudienceCodes(coupon.targetAudienceCodes);
      if (!targetAudienceCodes.length) return;
      if (!coupon.shortCode) coupon.shortCode = createCouponShortCode(data.coupons);
      const couponForDelivery = { ...coupon, shortUrl: couponShortUrl(coupon, req) };
      const message = formatCouponMessage(couponForDelivery);
      queueItem = {
        id: createId('queue'),
        kind: 'coupon',
        couponId: coupon.id,
        offerId: null,
        offerTitle: coupon.title,
        store: coupon.store || 'Magalu',
        targetAudienceCodes,
        couponSnapshot: { ...couponForDelivery, targetAudienceCodes },
        message,
        messageSource: 'coupon',
        aiStatus: 'not-applicable',
        image: coupon.image || '',
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
        sentAt: null,
        error: null,
        force: Boolean(req.body?.force)
      };
      data.queue.push(queueItem);
    });
    if (!queueItem) return res.status(400).json({ error: 'Cupom não encontrado, inativo ou sem grupos selecionados.' });
    await addLog(`${queueItem.force ? 'Cupom priorizado' : 'Cupom enviado para a fila'}: ${queueItem.offerTitle} → ${queueItem.targetAudienceCodes.join(', ')}`, queueItem.force ? 'success' : 'info');
    return res.status(201).json(queueItem);
  }
);

app.post(
  '/api/admin/collect',
  requireAdmin,
  async (
    _req,
    res
  ) =>
    res.json(
      await runCollectionWhenIdle({
        requestedByAdmin: true,
        allowOutsidePublishingWindow: true
      })
    )
);

/*
 * ==========================================================
 * TESTES DAS FONTES
 * ==========================================================
 */

app.post(
  '/api/admin/sources/shopee/test',
  requireAdmin,
  async (
    _req,
    res
  ) => {
    const {
      config
    } =
      await readStore();

    const secrets =
      await readSecrets();

    try {
      const offers =
        await collectShopee(
          {
            ...config,

            enableShopee:
              true
          },
          secrets
        );

      res.json({
        ok: true,

        count:
          offers.length,

        sample:
          offers[0]
            ?.title ||
          null
      });
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            `Shopee: ${error.message}`
        });
    }
  }
);

app.post(
  '/api/admin/sources/aliexpress/test',
  requireAdmin,
  async (
    _req,
    res
  ) => {
    const {
      config
    } =
      await readStore();

    const secrets =
      await readSecrets();

    try {
      const offers =
        await collectAliexpress(
          {
            ...config,

            enableAliexpress:
              true
          },
          secrets
        );

      res.json({
        ok: true,

        count:
          offers.length,

        sample:
          offers[0]
            ?.title ||
          null
      });
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            `AliExpress: ${error.message}`
        });
    }
  }
);

/*
 * Testa as IAs de verdade.
 *
 * Não usa fallback local aqui,
 * porque o objetivo do botão
 * é verificar se alguma IA
 * realmente está disponível.
 */
app.post(
  '/api/admin/ai/test',
  requireAdmin,
  async (
    _req,
    res
  ) => {
    const data =
      await readStore();

    const offer =
      data.offers.find(
        (item) =>
          item.status ===
          'active' &&
          item.affiliateUrl
      );

    if (!offer) {
      return res
        .status(400)
        .json({
          error:
            'Cadastre uma oferta ativa antes de testar a IA.'
        });
    }

    try {
      const message =
        await generateOfferMessage(
          offer,
          data.config
        );

      res.json({
        ok: true,
        message,

        offerTitle:
          offer.title
      });
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            `IA: ${error.message}`
        });
    }
  }
);

/*
 * ==========================================================
 * FILA - ADMIN
 * ==========================================================
 */

app.delete(
  '/api/admin/queue/failed',
  requireAdmin,
  async (_req, res) => {
    let removed = 0;

    await updateStore((data) => {
      const before = data.queue.length;
      data.queue = data.queue.filter((item) => item.status !== 'failed');
      removed = before - data.queue.length;
    });

    await addLog(
      removed > 0
        ? `${removed} publicação(ões) com falha removida(s) da fila.`
        : 'Nenhuma publicação com falha para remover da fila.',
      removed > 0 ? 'success' : 'info'
    );

    res.json({ ok: true, removed });
  }
);

app.delete(
  '/api/admin/queue/:id',
  requireAdmin,
  async (
    req,
    res
  ) => {
    await updateStore(
      (data) => {
        data.queue =
          data.queue.filter(
            (item) =>
              item.id !==
              req.params.id ||
              item.status ===
              'sent'
          );
      }
    );

    await addLog(
      'Item removido da fila.'
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  '/api/admin/queue/:id/force',
  requireAdmin,
  async (
    req,
    res
  ) => {
    let item;

    await updateStore(
      (data) => {
        item =
          data.queue.find(
            (entry) =>
              entry.id ===
              req.params.id &&
              entry.status ===
              'pending'
          );

        if (item) {
          item.force =
            true;
        }
      }
    );

    if (!item) {
      return res
        .status(404)
        .json({
          error:
            'Item pendente não encontrado.'
        });
    }

    await addLog(
      `Publicação priorizada para envio imediato: ${item.offerTitle}`,
      'success'
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  '/api/admin/queue/:id/retry',
  requireAdmin,
  async (
    req,
    res
  ) => {
    let item;

    await updateStore(
      (data) => {
        item =
          data.queue.find(
            (entry) =>
              entry.id ===
              req.params.id &&
              entry.status ===
              'failed'
          );

        if (item) {
          item.status =
            'pending';

          item.force =
            true;

          item.error =
            null;

          item.failedAt =
            null;

          delete item.aiStatus;
          delete item.aiError;
          delete item.aiRetryAt;
        }
      }
    );

    if (!item) {
      return res
        .status(404)
        .json({
          error:
            'Publicação com falha não encontrada.'
        });
    }

    await addLog(
      `Nova tentativa priorizada: ${item.offerTitle}`,
      'success'
    );

    res.json({
      ok: true
    });
  }
);

/*
 * ==========================================================
 * WHATSAPP ADMIN
 * ==========================================================
 */

app.post(
  '/api/admin/whatsapp/start',
  requireAdmin,
  async (
    req,
    res
  ) => {
    const mode =
      req.body.mode ===
      'phone'
        ? 'phone'
        : 'qr';

    const phoneNumber =
      String(
        req.body.phoneNumber ||
        ''
      ).replace(
        /\D/g,
        ''
      );

    if (
      mode === 'phone' &&
      (
        phoneNumber.length <
        10 ||
        phoneNumber.length >
        15
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Informe o número com código do país e DDD, somente números.'
        });
    }

    const result =
      await startWhatsappWorker({
        mode,
        phoneNumber
      });

    res.json({
      ok: true,

      message:
        result.message
    });
  }
);

app.post(
  '/api/admin/whatsapp/stop',
  requireAdmin,
  async (
    _req,
    res
  ) => {
    whatsappStopRequested =
      true;

    if (
      whatsappRestartTimer
    ) {
      clearTimeout(
        whatsappRestartTimer
      );
    }

    whatsappRestartTimer =
      null;

    if (
      whatsappProcess &&
      whatsappProcess
        .exitCode === null
    ) {
      whatsappProcess.kill();
    }

    whatsappProcess =
      null;

    await updateStore(
      (store) => {
        store.meta.whatsapp = {
          ...store.meta
            .whatsapp,

          status:
            'offline',

          qrDataUrl:
            null,

          pairingCode:
            null,

          message:
            'Publicador parado pelo painel.'
        };
      }
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  '/api/admin/whatsapp/reconnect',
  requireAdmin,
  async (_req, res) => {
    const data = await readStore();
    const whatsapp = data.meta.whatsapp || {};
    const processRunning = Boolean(whatsappProcess) && whatsappProcess.exitCode === null;
    const lastSeenAt = whatsapp.lastSeenAt ? new Date(whatsapp.lastSeenAt).getTime() : 0;
    const heartbeatFresh = lastSeenAt > 0 && Date.now() - lastSeenAt < 30_000;

    if (processRunning && whatsapp.status === 'connected' && heartbeatFresh) {
      return res.json({
        ok: true,
        connected: true,
        processRunning: true,
        status: 'connected',
        message: 'WhatsApp já estava conectado. O painel foi atualizado.'
      });
    }

    const transitionalStatuses = new Set(['starting', 'qr', 'pairing', 'authenticated']);

    if (processRunning && heartbeatFresh && transitionalStatuses.has(whatsapp.status)) {
      return res.json({
        ok: true,
        connected: false,
        reconnecting: false,
        processRunning: true,
        status: whatsapp.status,
        message: 'O publicador já está iniciando. Aguarde alguns segundos para o painel atualizar.'
      });
    }

    if (processRunning) {
      const processToRestart = whatsappProcess;
      whatsappStopRequested = true;
      processToRestart.kill();

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        processToRestart.once('exit', finish);
        setTimeout(finish, 3_000);
      });

      if (whatsappProcess === processToRestart) whatsappProcess = null;
      whatsappStopRequested = false;
    }

    whatsappRestartAttempts = 0;
    const result = await startWhatsappWorker({ mode: 'qr', automatic: true });

    return res.json({
      ok: true,
      connected: false,
      reconnecting: Boolean(result.started),
      processRunning: Boolean(result.started),
      status: 'starting',
      message: result.started
        ? 'Reconexão iniciada. A sessão salva será restaurada; se necessário, um novo QR Code aparecerá.'
        : result.message
    });
  }
);

app.post(
  '/api/admin/whatsapp/check',
  requireAdmin,
  async (
    _req,
    res
  ) => {
    const data =
      await readStore();

    const whatsapp =
      data.meta.whatsapp ||
      {};

    const lastSeenAt =
      whatsapp.lastSeenAt
        ? new Date(
            whatsapp.lastSeenAt
          ).getTime()
        : 0;

    const heartbeatAge =
      lastSeenAt
        ? Date.now() -
          lastSeenAt
        : Infinity;

    const processRunning =
      Boolean(
        whatsappProcess
      ) &&
      whatsappProcess
        .exitCode === null;

    const heartbeatFresh =
      heartbeatAge <
      30_000;

    const connected =
      processRunning &&
      heartbeatFresh &&
      whatsapp.status ===
      'connected';

    res.json({
      ok: true,
      connected,
      processRunning,

      status:
        connected
          ? 'connected'
          : whatsapp.status ||
            'offline',

      lastSeenAt:
        whatsapp.lastSeenAt ||
        null,

      message:
        connected
          ? 'WhatsApp conectado e publicador respondendo normalmente.'
          : !processRunning
            ? 'O publicador do WhatsApp não está em execução.'
            : !heartbeatFresh
              ? 'O publicador está aberto, mas não respondeu recentemente.'
              : whatsapp.message ||
                'WhatsApp não conectado.'
    });
  }
);

/*
 * ==========================================================
 * WORKER - PRÓXIMA OFERTA
 * ==========================================================
 */

app.get(
  '/api/worker/queue/next',
  requireWorker,
  async (
    req,
    res
  ) => {
    if (collectionInProgress) {
      return res
        .status(204)
        .end();
    }

    const {
      config,
      queue,
      offers
    } =
      await readStore();

    const now =
      new Date();

    const forced =
      queue.find(
        (item) =>
          item.status ===
          'pending' &&
          item.force
      );

    /*
     * ======================================================
     * PREPARA PRODUTO PARA ENVIO
     * ======================================================
     *
     * Fluxo:
     *
     * 1. tenta classificar com IA;
     * 2. se a IA falhar, usa o filtro local;
     * 3. tenta gerar o texto com IA;
     * 4. se todas as IAs falharem, usa texto local;
     * 5. publica normalmente.
     *
     * Durante uma rodada:
     *
     * G01 recebe somente G01;
     * G02 recebe somente G02;
     * G03 recebe somente G03;
     * etc.
     */
    async function prepareWithAi(
      item,
      roundAudienceCode = ''
    ) {
      if (!item) {
        return null;
      }

      try {
        if (item.kind === 'coupon') {
          const coupon = item.couponSnapshot || {};
          const selectedCodes = normalizeCouponAudienceCodes(
            item.targetAudienceCodes || coupon.targetAudienceCodes
          );
          const normalizedRoundAudienceCode = normalizeAudienceCode(roundAudienceCode);

          if (
            normalizedRoundAudienceCode &&
            !selectedCodes.includes(normalizedRoundAudienceCode)
          ) {
            return { skippedForAudience: true };
          }

          const deliveryAudienceCodes = normalizedRoundAudienceCode
            ? [normalizedRoundAudienceCode]
            : selectedCodes;

          if (!deliveryAudienceCodes.length || !coupon.title || !coupon.link) {
            throw new Error('Cupom sem título, link ou grupo selecionado.');
          }

          const message = stripAffiliateDisclosure(
            item.message || formatCouponMessage(coupon)
          );
          await updateStore((data) => {
            const saved = data.queue.find(
              (entry) => entry.id === item.id && entry.status === 'pending'
            );
            if (!saved) return;
            saved.message = message;
            saved.messageSource = 'coupon';
            saved.aiStatus = 'not-applicable';
            saved.targetAudienceCodes = [...deliveryAudienceCodes];
            saved.roundAudienceCode = normalizedRoundAudienceCode || null;
            delete saved.aiRetryAt;
            delete saved.aiError;
          });

          return {
            ...item,
            message,
            messageSource: 'coupon',
            aiStatus: 'not-applicable',
            targetAudienceCodes: deliveryAudienceCodes,
            roundAudienceCode: normalizedRoundAudienceCode || null
          };
        }

        const offer =
          offers.find(
            (entry) =>
              entry.id ===
              item.offerId
          ) ||
          item.offerSnapshot;

        /*
         * Dados mínimos necessários.
         */
        if (
          !offer?.title ||
          !offer?.affiliateUrl ||
          !Number(
            offer?.price
          )
        ) {
          throw new Error(
            'Os dados completos do produto não estão mais disponíveis para publicação.'
          );
        }

        /*
         * ==================================================
         * ROTEAMENTO
         * ==================================================
         */

        let targetAudienceCodes =
          Array.isArray(
            item
              .targetAudienceCodes
          )
            ? [
                ...item
                  .targetAudienceCodes
              ]
            : [];

        if (
          config.aiEnabled !==
            false &&
          config
            .aiAudienceRoutingEnabled !==
            false
        ) {
          /*
           * A função classifyOfferAudience()
           * já possui fallback local.
           */
          targetAudienceCodes =
            await classifyOfferAudience(
              offer,
              config
            );
        } else {
          targetAudienceCodes =
            getAudienceCodesForOffer(
              offer,
              config
                .whatsappAudiences
            );
        }

        targetAudienceCodes = [
          ...new Set(
            (
              targetAudienceCodes ||
              []
            )
              .map(
                (code) =>
                  normalizeAudienceCode(
                    code
                  )
              )
              .filter(Boolean)
          )
        ];

        if (
          !targetAudienceCodes
            .length
        ) {
          throw new Error(
            'Nenhum grupo adequado foi encontrado para este produto.'
          );
        }

        /*
         * Público que a rodada está
         * tentando alimentar agora.
         */
        const normalizedRoundAudienceCode =
          normalizeAudienceCode(
            roundAudienceCode
          );

        /*
         * Na rodada, validamos também
         * com o roteador local.
         *
         * Isso evita que uma IA mande
         * produto para categoria errada.
         */
        if (
          normalizedRoundAudienceCode
        ) {
          const localCodes =
            getAudienceCodesForOffer(
              offer,
              config
                .whatsappAudiences
            )
              .map(
                (code) =>
                  normalizeAudienceCode(
                    code
                  )
              )
              .filter(Boolean);

          if (
            !localCodes.includes(
              normalizedRoundAudienceCode
            )
          ) {
            return {
              skippedForAudience:
                true
            };
          }
        }

        /*
         * ==================================================
         * DESTINO REAL DESTA PUBLICAÇÃO
         * ==================================================
         *
         * Fora de rodada:
         * usa os grupos normais do produto.
         *
         * Dentro da rodada:
         * envia APENAS para o grupo atual.
         *
         * Exemplo:
         *
         * Produto classificado:
         * G01 + G02
         *
         * Rodada atual:
         * G02
         *
         * Envio real:
         * somente G02.
         */
        const deliveryAudienceCodes =
          normalizedRoundAudienceCode
            ? [
                normalizedRoundAudienceCode
              ]
            : [
                ...targetAudienceCodes
              ];

        /*
         * Mantemos no objeto local
         * exatamente os destinos que
         * o worker deverá usar.
         */
        offer.targetAudienceCodes =
          [
            ...deliveryAudienceCodes
          ];

        /*
         * ==================================================
         * TEXTO
         * ==================================================
         */

        let message;
        let messageSource;
        let aiStatus;
        let aiError = '';

        if (
          config.aiEnabled ===
          false
        ) {
          /*
           * IA desligada manualmente.
           */
          message =
            generateFallbackOfferMessage(
              offer,
              config
            );

          messageSource =
            'fallback';

          aiStatus =
            'fallback-disabled';

          console.log(
            `[FALLBACK LOCAL] IA desativada. Texto local criado para "${item.offerTitle}".`
          );
        } else {
          try {
            /*
             * Ordem configurada no ai.js:
             *
             * Gemini
             * ↓
             * OpenAI
             * ↓
             * Groq
             */
            message =
              await generateOfferMessage(
                {
                  ...offer,

                  publicationId:
                    item.id
                },
                config
              );

            messageSource =
              'ai';

            aiStatus =
              'generated';

            console.log(
              `[IA] Texto criado para "${item.offerTitle}".`
            );
          } catch (error) {
            /*
             * Todas as IAs falharam.
             *
             * Não para a publicação.
             */
            aiError =
              String(
                error?.message ||
                error
              ).slice(
                0,
                500
              );

            message =
              generateFallbackOfferMessage(
                offer,
                config
              );

            messageSource =
              'fallback';

            aiStatus =
              'fallback';

            console.warn(
              `[FALLBACK LOCAL] Todas as IAs falharam para "${item.offerTitle}". A publicação continuará com texto local. ${aiError}`
            );

            await addLog(
              `IA indisponível para ${item.offerTitle}. O sistema usará o texto local e continuará publicando.`,
              'info'
            );
          }
        }

        /*
         * Segurança final da mensagem.
         */
        if (
          !String(
            message || ''
          ).trim()
        ) {
          throw new Error(
            'Não foi possível criar uma mensagem para a oferta.'
          );
        }

        message = stripAffiliateDisclosure(message);

        /*
         * ==================================================
         * SALVA PREPARAÇÃO
         * ==================================================
         */

        await updateStore(
          (data) => {
            const saved =
              data.queue.find(
                (entry) =>
                  entry.id ===
                    item.id &&
                  entry.status ===
                    'pending'
              );

            if (!saved) {
              return;
            }

            /*
             * Se estiver dentro da rodada,
             * registra qual público receberá.
             */
            if (
              normalizedRoundAudienceCode
            ) {
              saved.roundAudienceCode =
                normalizedRoundAudienceCode;
            }

            saved.message =
              message;

            /*
             * MUITO IMPORTANTE:
             *
             * salva SOMENTE o destino
             * desta publicação.
             */
            saved.targetAudienceCodes =
              [
                ...deliveryAudienceCodes
              ];

            if (
              saved.offerSnapshot
            ) {
              saved
                .offerSnapshot
                .targetAudienceCodes =
                [
                  ...deliveryAudienceCodes
                ];
            }

            saved.messageSource =
              messageSource;

            saved.aiStatus =
              aiStatus;

            saved.aiGenerationVersion =
              aiGenerationVersion;

            if (
              messageSource ===
              'ai'
            ) {
              saved.aiGeneratedAt =
                new Date()
                  .toISOString();

              delete saved.aiError;
              delete saved
                .fallbackGeneratedAt;
            } else {
              saved.fallbackGeneratedAt =
                new Date()
                  .toISOString();

              if (aiError) {
                saved.aiError =
                  aiError.slice(
                    0,
                    300
                  );
              }
            }

            delete saved.aiRetryAt;
          }
        );

        if (
          messageSource ===
          'ai'
        ) {
          await addLog(
            `IA criou o texto da oferta: ${item.offerTitle}. Destino: ${deliveryAudienceCodes.join(', ')}.`,
            'success'
          );
        } else {
          await addLog(
            `Texto local criado para ${item.offerTitle}. Destino: ${deliveryAudienceCodes.join(', ')}.`,
            'info'
          );
        }

        return {
          ...item,

          /*
           * O worker do WhatsApp
           * recebe somente estes grupos.
           */
          targetAudienceCodes:
            [
              ...deliveryAudienceCodes
            ],

          roundAudienceCode:
            normalizedRoundAudienceCode ||
            null,

          message,
          messageSource,
          aiStatus,
          aiGenerationVersion
        };
      } catch (error) {
        const errorMessage =
          String(
            error?.message ||
            'Erro desconhecido'
          );

        /*
         * Produto perdeu dados essenciais.
         */
        if (
          errorMessage.includes(
            'Os dados completos do produto não estão mais disponíveis'
          )
        ) {
          await updateStore(
            (data) => {
              const saved =
                data.queue.find(
                  (entry) =>
                    entry.id ===
                      item.id &&
                    entry.status ===
                      'pending'
                );

              if (!saved) {
                return;
              }

              saved.status =
                'failed';

              saved.force =
                false;

              saved.message =
                '';

              saved.messageSource =
                'failed';

              saved.aiStatus =
                'failed';

              saved.aiError =
                errorMessage.slice(
                  0,
                  300
                );

              saved.failedAt =
                new Date()
                  .toISOString();

              delete saved.aiRetryAt;
            }
          );

          await addLog(
            `Produto ignorado: ${item.offerTitle}. Dados incompletos.`,
            'error'
          );

          return {
            skipped: true
          };
        }

        /*
         * Produto sem grupo seguro.
         */
        if (
          errorMessage.includes(
            'Nenhum grupo adequado'
          )
        ) {
          await updateStore(
            (data) => {
              const saved =
                data.queue.find(
                  (entry) =>
                    entry.id ===
                      item.id &&
                    entry.status ===
                      'pending'
                );

              if (!saved) {
                return;
              }

              saved.status =
                'failed';

              saved.force =
                false;

              saved.message =
                '';

              saved.messageSource =
                'routing-failed';

              saved.aiStatus =
                'routing-failed';

              saved.aiError =
                errorMessage.slice(
                  0,
                  300
                );

              saved.failedAt =
                new Date()
                  .toISOString();

              delete saved.aiRetryAt;
            }
          );

          await addLog(
            `Produto ignorado por segurança: ${item.offerTitle}. Nenhum grupo adequado foi encontrado.`,
            'error'
          );

          return {
            skipped: true
          };
        }

        /*
         * Erro inesperado.
         *
         * Aqui vale tentar novamente.
         */
        const retryAt =
          new Date(
            Date.now() +
            60_000
          ).toISOString();

        await updateStore(
          (data) => {
            const saved =
              data.queue.find(
                (entry) =>
                  entry.id ===
                    item.id &&
                  entry.status ===
                    'pending'
              );

            if (!saved) {
              return;
            }

            saved.aiStatus =
              'waiting';

            saved.aiError =
              errorMessage.slice(
                0,
                300
              );

            saved.aiRetryAt =
              retryAt;
          }
        );

        await addLog(
          `Não foi possível preparar ${item.offerTitle}; nova tentativa em 1 minuto (${errorMessage}).`,
          'error'
        );

        return null;
      }
    }

    /*
     * ======================================================
     * PUBLICAR AGORA
     * ======================================================
     *
     * Publicação forçada continua
     * funcionando fora da lógica de rodada.
     */
    if (
      req.query.forced ===
      '1'
    ) {
      const prepared =
        forced
          ? await prepareWithAi(
              forced
            )
          : null;

      if (
        prepared &&
        !prepared.skipped &&
        !prepared
          .skippedForAudience
      ) {
        return res.json(
          prepared
        );
      }

      return res
        .status(204)
        .end();
    }

    /*
     * Se existe uma oferta marcada
     * com force=true, ela tem prioridade.
     */
    if (forced) {
      const prepared =
        await prepareWithAi(
          forced
        );

      if (
        prepared &&
        !prepared.skipped &&
        !prepared
          .skippedForAudience
      ) {
        return res.json(
          prepared
        );
      }

      if (!prepared) {
        return res
          .status(204)
          .end();
      }
    }

    /*
     * ======================================================
     * HORÁRIO DE PUBLICAÇÃO
     * ======================================================
     */

    const hourMinute =
      now.toLocaleTimeString(
        'pt-BR',
        {
          timeZone:
            'America/Sao_Paulo',

          hour:
            '2-digit',

          minute:
            '2-digit',

          hour12:
            false
        }
      );

    const publishingStart =
      config.publishingStart ||
      config.quietEnd ||
      '08:00';

    const publishingEnd =
      config.publishingEnd ||
      config.quietStart ||
      '23:00';

    const isPublishingTime =
      publishingStart ===
        publishingEnd ||
      (
        publishingStart <
        publishingEnd
          ? (
              hourMinute >=
                publishingStart &&
              hourMinute <
                publishingEnd
            )
          : (
              hourMinute >=
                publishingStart ||
              hourMinute <
                publishingEnd
            )
      );

    if (
      !isPublishingTime
    ) {
      return res
        .status(204)
        .end();
    }

    /*
     * ======================================================
     * LIMITE DIÁRIO
     * ======================================================
     */

    const today =
      now
        .toISOString()
        .slice(
          0,
          10
        );

    const sentToday =
      queue.filter(
        (item) =>
          item.status ===
            'sent' &&
          item.sentAt
            ?.slice(
              0,
              10
            ) === today
      ).length;

    if (
      sentToday >=
      Number(
        config.maxPostsPerDay ||
        100
      )
    ) {
      return res
        .status(204)
        .end();
    }

    /*
     * ======================================================
     * INTERVALO CONFIGURADO NO PAINEL
     * ======================================================
     *
     * Este intervalo vale ENTRE RODADAS.
     *
     * Exemplo:
     *
     * Painel = 15 minutos
     *
     * 10:00:
     * G01
     * G02
     * G03
     * ...
     * G10
     *
     * Próxima rodada:
     * aproximadamente 10:15.
     */

    const allowedIntervals =
      [
        5,
        10,
        15,
        20,
        25,
        30
      ];

    const intervalMinutes =
      allowedIntervals.includes(
        Number(
          config
            .whatsappIntervalMinutes
        )
      )
        ? Number(
            config
              .whatsappIntervalMinutes
          )
        : 15;

    const lastSentAt =
      queue
        .filter(
          (item) =>
            item.status ===
              'sent' &&
            item.sentAt
        )
        .reduce(
          (
            latest,
            item
          ) =>
            Math.max(
              latest,
              new Date(
                item.sentAt
              ).getTime()
            ),
          0
        );

    /*
     * ======================================================
     * RODADA POR PÚBLICO
     * ======================================================
     *
     * Exemplo:
     *
     * G01 → produto A
     * G02 → produto B
     * G03 → produto C
     * G04 → produto D
     * ...
     *
     * Um produto não pode atender dois
     * grupos na mesma rodada.
     */

    /*
     * Verifica se já existe
     * uma rodada em andamento.
     */
    let round =
      await getPublicationRound(
        false
      );

    /*
     * Se NÃO existe rodada,
     * significa que estamos prestes
     * a começar uma nova.
     *
     * Aqui aplicamos o intervalo
     * configurado no painel.
     */
    if (!round) {
      if (
        lastSentAt &&
        now.getTime() -
          lastSentAt <
        intervalMinutes *
          60_000
      ) {
        return res
          .status(204)
          .end();
      }

      /*
       * Intervalo cumprido.
       * Agora começa a nova rodada.
       */
      round =
        await getPublicationRound(
          true
        );
    }

    if (!round) {
      return res
        .status(204)
        .end();
    }

    /*
     * Ofertas disponíveis
     * para a rodada.
     */
    const pendingItems =
      queue.filter(
        (item) =>
          item.status ===
            'pending' &&
          !item.force
      );

    /*
     * Enquanto existirem públicos
     * pendentes na rodada...
     */
    while (
      round &&
      round
        .pendingAudienceCodes
        .length
    ) {
      const audienceCode =
        normalizeAudienceCode(
          round
            .pendingAudienceCodes[
              0
            ]
        );

      /*
       * ====================================================
       * PROCURA PRODUTO PARA O PÚBLICO ATUAL
       * ====================================================
       */

      const candidates =
        pendingItems.filter(
          (item) => {
            /*
             * Não reutiliza produto
             * já usado nesta rodada.
             */
            const itemRoundId = item.kind === 'coupon' ? item.id : item.offerId;
            if (itemRoundId && round.usedOfferIds.includes(itemRoundId)) {
              return false;
            }

            const localCodes =
              getLocalCodesForQueueItem(
                item,
                offers,
                config
              );

            return localCodes.includes(
              audienceCode
            );
          }
        );

      /*
       * Nenhuma promoção disponível
       * para esse grupo.
       *
       * Pulamos o grupo SOMENTE nesta rodada.
       */
      if (
        !candidates.length
      ) {
        await addLog(
          `Rodada ${round.id}: nenhum produto disponível para ${audienceCode}. Grupo ignorado nesta rodada.`,
          'info'
        );

        await skipRoundAudience(
          round.id,
          audienceCode
        );

        round =
          await getPublicationRound(
            false
          );

        /*
         * Acabou a rodada.
         *
         * Não cria outra agora.
         * A próxima esperará o intervalo.
         */
        if (!round) {
          return res
            .status(204)
            .end();
        }

        continue;
      }

      let productPrepared =
        false;

      /*
       * Testa candidatos até
       * encontrar um produto válido.
       */
      for (
        const item
        of candidates
      ) {
        const prepared =
          await prepareWithAi(
            item,
            audienceCode
          );

        if (
          prepared?.skipped
        ) {
          continue;
        }

        if (
          prepared
            ?.skippedForAudience
        ) {
          continue;
        }

        if (prepared) {
          /*
           * Registra oficialmente que
           * este item pertence à rodada.
           */
          await updateStore(
            (data) => {
              const saved =
                data.queue.find(
                  (entry) =>
                    entry.id ===
                      item.id &&
                    entry.status ===
                      'pending'
                );

              if (!saved) {
                return;
              }

              saved.roundId =
                round.id;

              saved.roundAudienceCode =
                audienceCode;

              /*
               * Segurança extra:
               * somente este público.
               */
              saved.targetAudienceCodes =
                [
                  audienceCode
                ];

              if (
                saved.offerSnapshot
              ) {
                saved
                  .offerSnapshot
                  .targetAudienceCodes =
                  [
                    audienceCode
                  ];
              }
            }
          );

          await addLog(
            `Rodada ${round.id}: ${item.offerTitle} selecionado para ${audienceCode}.`,
            'success'
          );

          productPrepared =
            true;

          return res.json({
            ...prepared,

            targetAudienceCodes:
              [
                audienceCode
              ],

            roundId:
              round.id,

            roundAudienceCode:
              audienceCode
          });
        }
      }

      /*
       * Havia candidatos,
       * porém nenhum era válido.
       */
      if (
        !productPrepared
      ) {
        await addLog(
          `Rodada ${round.id}: nenhum produto válido pôde ser preparado para ${audienceCode}.`,
          'info'
        );

        await skipRoundAudience(
          round.id,
          audienceCode
        );

        round =
          await getPublicationRound(
            false
          );

        if (!round) {
          return res
            .status(204)
            .end();
        }
      }
    }

    return res
      .status(204)
      .end();
  }
);

/*
 * ==========================================================
 * CONFIGURAÇÃO DO WORKER
 * ==========================================================
 */

app.get(
  '/api/worker/config',
  requireWorker,
  async (
    _req,
    res
  ) => {
    const {
      config
    } =
      await readStore();

    const selectedGroups =
      Array.isArray(
        config.whatsappGroups
      )
        ? config
            .whatsappGroups
            .slice(
              0,
              100
            )
            .map(
              (group) => ({
                id:
                  String(
                    group.id ||
                    ''
                  ).slice(
                    0,
                    120
                  ),

                name:
                  String(
                    group.name ||
                    ''
                  ).slice(
                    0,
                    160
                  )
              })
            )
            .filter(
              (group) =>
                group.id
            )
        : [];

    if (
      !selectedGroups.length &&
      config.whatsappGroupId
    ) {
      selectedGroups.push({
        id:
          config
            .whatsappGroupId,

        name:
          config
            .whatsappGroupName ||
          ''
      });
    }

    res.json({
      selectedGroups,

      groupId:
        config.whatsappGroupId ||
        '',

      groupName:
        config.whatsappGroupName ||
        '',

      maxPerHour:
        Number(
          config
            .whatsappMaxPerHour ||
          100
        ),

      communityEnabled:
        config.whatsappCommunityEnabled !== false,

      communityName:
        String(
          config.whatsappCommunityName ||
          'PromoShop - Ofertas'
        ).slice(0, 160)
    });
  }
);

/*
 * ==========================================================
 * SINCRONIZA GRUPOS
 * ==========================================================
 */

app.post(
  '/api/worker/groups',
  requireWorker,
  async (
    req,
    res
  ) => {
    const groups =
      Array.isArray(
        req.body.groups
      )
        ? req.body.groups
            .slice(
              0,
              500
            )
            .map(
              (group) => ({
                id:
                  String(
                    group.id ||
                    ''
                  ).slice(
                    0,
                    120
                  ),

                name:
                  String(
                    group.name ||
                    ''
                  ).slice(
                    0,
                    160
                  )
              })
            )
            .filter(
              (group) =>
                group.id
            )
        : [];

    await updateStore(
      (data) => {
        data.meta =
          data.meta || {};

        data.meta.whatsapp = {
          ...data.meta
            .whatsapp,

          groups,

          lastSeenAt:
            new Date()
              .toISOString()
        };
      }
    );

    await addLog(
      `WhatsApp: ${groups.length} grupos encontrados.`,
      'success'
    );

    res.json({
      ok: true,

      count:
        groups.length
    });
  }
);

/*
 * ==========================================================
 * QR CODE
 * ==========================================================
 */

app.post(
  '/api/worker/qr',
  requireWorker,
  async (
    req,
    res
  ) => {
    if (
      !req.body.qr
    ) {
      return res
        .status(400)
        .json({
          error:
            'QR Code ausente.'
        });
    }

    const qrDataUrl =
      await QRCode.toDataURL(
        req.body.qr,
        {
          width: 320,
          margin: 2
        }
      );

    await updateStore(
      (data) => {
        data.meta =
          data.meta || {};

        data.meta.whatsapp = {
          ...data.meta
            .whatsapp,

          status:
            'qr',

          lastSeenAt:
            new Date()
              .toISOString(),

          qrDataUrl,

          pairingCode:
            null,

          message:
            'Leia o QR Code com o WhatsApp.'
        };
      }
    );

    res.json({
      ok: true
    });
  }
);

/*
 * ==========================================================
 * CÓDIGO DE PAREAMENTO
 * ==========================================================
 */

app.post(
  '/api/worker/pairing-code',
  requireWorker,
  async (
    req,
    res
  ) => {
    const pairingCode =
      String(
        req.body.code ||
        ''
      )
        .replace(
          /[^A-Z0-9]/gi,
          ''
        )
        .toUpperCase()
        .slice(
          0,
          12
        );

    if (!pairingCode) {
      return res
        .status(400)
        .json({
          error:
            'Código ausente.'
        });
    }

    await updateStore(
      (data) => {
        data.meta =
          data.meta || {};

        data.meta.whatsapp = {
          ...data.meta
            .whatsapp,

          status:
            'pairing',

          lastSeenAt:
            new Date()
              .toISOString(),

          qrDataUrl:
            null,

          pairingCode,

          message:
            'Digite este código no WhatsApp do celular.'
        };
      }
    );

    res.json({
      ok: true
    });
  }
);

/*
 * ==========================================================
 * HEARTBEAT
 * ==========================================================
 */

app.post(
  '/api/worker/heartbeat',
  requireWorker,
  async (
    req,
    res
  ) => {
    const allowedStatuses = [
      'starting',
      'qr',
      'pairing',
      'authenticated',
      'connected',
      'offline',
      'error'
    ];

    const status =
      allowedStatuses.includes(
        req.body.status
      )
        ? req.body.status
        : 'starting';

    if (
      status ===
      'connected'
    ) {
      whatsappRestartAttempts =
        0;
    }

    await updateStore(
      (data) => {
        data.meta =
          data.meta || {};

        data.meta.whatsapp = {
          ...data.meta
            .whatsapp,

          status,

          lastSeenAt:
            new Date()
              .toISOString(),

          qrDataUrl:
            [
              'authenticated',
              'connected'
            ].includes(
              status
            )
              ? null
              : data.meta
                  .whatsapp
                  ?.qrDataUrl,

          pairingCode:
            status ===
            'connected'
              ? null
              : data.meta
                  .whatsapp
                  ?.pairingCode,

          message:
            String(
              req.body
                .message ||
              ''
            ).slice(
              0,
              200
            )
        };
      }
    );

    res.json({
      ok: true
    });
  }
);

/*
 * ==========================================================
 * PUBLICAÇÃO CONCLUÍDA
 * ==========================================================
 */

app.post(
  '/api/worker/queue/:id/complete',
  requireWorker,
  async (
    req,
    res
  ) => {
    let completedItem = null;
    let instagramQueuedItem = null;

    await updateStore(
      (data) => {
        const item =
          data.queue.find(
            (entry) =>
              entry.id ===
              req.params.id
          );

        if (!item) {
          return;
        }

        item.status =
          'sent';

        item.sentAt =
          new Date()
            .toISOString();

        item.error =
          null;

        completedItem = {
          id:
            item.id,

          offerId:
            item.offerId,

          offerTitle:
            item.offerTitle,

          roundId:
            item.roundId,

          roundAudienceCode:
            item.roundAudienceCode
        };

        instagramQueuedItem = enqueueInstagramFromWhatsapp(data, item);

        /*
         * ==================================================
         * ATUALIZA A RODADA
         * ==================================================
         */

        const round =
          data.meta
            ?.publicationRound;

        if (
          round &&
          item.roundId &&
          round.id ===
            item.roundId &&
          item.roundAudienceCode
        ) {
          const audienceCode =
            normalizeAudienceCode(
              item
                .roundAudienceCode
            );

          /*
           * Grupo foi atendido.
           */
          round.pendingAudienceCodes =
            (
              round
                .pendingAudienceCodes ||
              []
            ).filter(
              (code) =>
                normalizeAudienceCode(
                  code
                ) !==
                audienceCode
            );

          /*
           * Produto não poderá ser
           * usado novamente nesta rodada.
           */
          if (item.offerId || item.kind === 'coupon') {
            round.usedOfferIds = [
              ...new Set([
                ...(
                  round
                    .usedOfferIds ||
                  []
                ),

                item.kind === 'coupon' ? item.id : item.offerId
              ])
            ];
          }

          /*
           * Todos os públicos foram atendidos.
           *
           * Fecha a rodada.
           */
          if (
            !round
              .pendingAudienceCodes
              .length
          ) {
            round.completedAt =
              new Date()
                .toISOString();

            data.meta
              .lastPublicationRound = {
              ...round
            };

            data.meta
              .publicationRound =
              null;
          }
        }
      }
    );

    if (completedItem) {
      if (
        completedItem
          .roundAudienceCode
      ) {
        await addLog(
          `WhatsApp: ${completedItem.offerTitle} enviado para ${completedItem.roundAudienceCode}.`,
          'success'
        );
      } else {
        await addLog(
          `WhatsApp: publicação enviada (${req.params.id}).`,
          'success'
        );
      }
    }

    if (instagramQueuedItem) {
      await addLog(`Instagram: ${instagramQueuedItem.title} entrou na fila de Stories após o envio no WhatsApp.`, 'success');
    }

    res.json({
      ok: true
    });
  }
);

/*
 * ==========================================================
 * FALHA NO ENVIO
 * ==========================================================
 */

app.post(
  '/api/worker/queue/:id/fail',
  requireWorker,
  async (
    req,
    res
  ) => {
    let failedItem = null;

    await updateStore(
      (data) => {
        const item =
          data.queue.find(
            (entry) =>
              entry.id ===
              req.params.id
          );

        if (!item) {
          return;
        }

        item.attempts =
          Number(
            item.attempts ||
            0
          ) + 1;

        item.status =
          item.attempts >= 3
            ? 'failed'
            : 'pending';

        item.error =
          String(
            req.body.error ||
            'Falha desconhecida'
          ).slice(
            0,
            500
          );

        /*
         * Se falhou definitivamente,
         * libera esse público da rodada.
         *
         * Assim a rodada não fica
         * presa para sempre.
         */
        if (
          item.status ===
            'failed' &&
          item.roundId &&
          item.roundAudienceCode
        ) {
          const round =
            data.meta
              ?.publicationRound;

          if (
            round &&
            round.id ===
              item.roundId
          ) {
            const audienceCode =
              normalizeAudienceCode(
                item
                  .roundAudienceCode
              );

            round.pendingAudienceCodes =
              (
                round
                  .pendingAudienceCodes ||
                []
              ).filter(
                (code) =>
                  normalizeAudienceCode(
                    code
                  ) !==
                  audienceCode
              );

            if (
              !round
                .pendingAudienceCodes
                .length
            ) {
              round.completedAt =
                new Date()
                  .toISOString();

              data.meta
                .lastPublicationRound = {
                ...round
              };

              data.meta
                .publicationRound =
                null;
            }
          }
        }

        failedItem = {
          title:
            item.offerTitle,

          status:
            item.status,

          attempts:
            item.attempts
        };
      }
    );

    await addLog(
      `WhatsApp: falha ao publicar${failedItem?.title ? ` ${failedItem.title}` : ''} (${String(req.body.error || 'erro')}).`,
      'error'
    );

    res.json({
      ok: true
    });
  }
);

/*
 * ==========================================================
 * ASSISTENTE PÚBLICO
 * ==========================================================
 */

app.post(
  '/api/assistant/recommend',
  async (
    req,
    res
  ) => {
    try {
      const clientIp =
        req.ip ||
        req.socket
          .remoteAddress ||
        'unknown';

      const limitState =
        checkAssistantLimit(
          clientIp
        );

      if (
        !limitState.allowed
      ) {
        res.setHeader(
          'Retry-After',
          String(
            limitState
              .retryAfter
          )
        );

        return res
          .status(429)
          .json({
            error:
              'Você fez muitas consultas ao assistente. Aguarde alguns minutos e tente novamente.'
          });
      }

      const message =
        String(
          req.body?.message ||
          ''
        ).trim();

      if (!message) {
        return res
          .status(400)
          .json({
            error:
              'Digite o que você está procurando.'
          });
      }

      if (
        message.length >
        1000
      ) {
        return res
          .status(400)
          .json({
            error:
              'Sua mensagem está muito longa.'
          });
      }

      const conversationReply = assistantConversationReply(message);
      if (conversationReply) {
        return res.json({
          status: 'chat',
          message: conversationReply,
          products: [],
          audiences: []
        });
      }

      const data = await readStore();
      const history = sanitizeAssistantHistory(req.body?.history);
      const userContext = [...history.filter((entry) => entry.role === 'user').map((entry) => entry.content), message].join(' ');
      const eligibleOffers = (Array.isArray(data.offers) ? data.offers : [])
        .filter((offer) => publicOfferAllowed(offer, data.config));
      const audiences = Array.isArray(data.config.whatsappAudiences)
        ? data.config.whatsappAudiences
        : [];
      const query = assistantCatalogQuery(userContext, eligibleOffers);
      const currentBudget = assistantBudgetFromText(message);
      const budget = currentBudget.specified ? currentBudget : assistantBudgetFromText(userContext);
      const requestedStore = assistantStoreFromText(userContext);
      const seenProductIds = new Set((Array.isArray(req.body?.seenProductIds) ? req.body.seenProductIds : [])
        .map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100));
      const interestAudiences = assistantAudienceRecommendations(userContext, [], audiences);

      if (!query) {
        if (interestAudiences.length) {
          return res.json({
            status: 'result',
            message: 'Encontrei os grupos que mais combinam com o que você gosta. Se quiser, também posso procurar um produto específico e perguntar sua faixa de preço.',
            products: [],
            audiences: interestAudiences
          });
        }
        return res.json({
          status: 'question',
          message: 'Claro! Qual produto você está procurando? Se puder, conte também para que vai usar e quanto pretende gastar.',
          products: [],
          audiences: []
        });
      }

      if (!budget.specified) {
        return res.json({
          status: 'question',
          message: `Entendi: você procura ${query}. Qual é o valor máximo que pretende gastar? Você também pode responder “sem limite”.`,
          products: [],
          audiences: interestAudiences
        });
      }

      let products = assistantProducts(query, eligibleOffers, data.config, data.analytics || {}, {
        maximum: budget.maximum,
        preferCheapest: budget.preferCheapest,
        store: requestedStore,
        seenProductIds
      });

      // Se a pessoa pediu mais opções e todas já foram vistas, recomeça a lista em vez de responder vazio.
      if (!products.length && seenProductIds.size) {
        products = assistantProducts(query, eligibleOffers, data.config, data.analytics || {}, {
          maximum: budget.maximum,
          preferCheapest: budget.preferCheapest,
          store: requestedStore,
          seenProductIds: new Set()
        });
      }

      if (!products.length) {
        const priceText = Number.isFinite(budget.maximum)
          ? ` até ${Number(budget.maximum).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
          : '';
        return res.json({
          status: 'question',
          message: `Não encontrei uma oferta pública de ${query}${priceText}${requestedStore ? ` na ${requestedStore}` : ''} agora. Quer tentar outro valor, loja, marca ou modelo?`,
          products: [],
          audiences: assistantAudienceRecommendations(userContext, [], audiences)
        });
      }

      const recommendedAudiences = assistantAudienceRecommendations(userContext, products, audiences);
      const productPayload = products.map((offer) => ({
        id: String(offer.id || ''),
        title: String(offer.title || ''),
        store: String(offer.store || ''),
        category: String(offer.category || ''),
        price: Number(offer.price || 0),
        originalPrice: Number(offer.originalPrice || 0),
        discount: offerDiscount(offer),
        image: String(offer.image || ''),
        affiliateUrl: String(offer.affiliateUrl || ''),
        publicSlug: offerPublicSlug(offer),
        freeShipping: offer.freeShipping === true
      }));

      return res.json({
        status: 'result',
        message: `Separei ${productPayload.length} ${productPayload.length === 1 ? 'oferta que combina' : 'ofertas que combinam'} com o seu pedido. Quer que eu refine por marca, loja, preço ou outra característica?`,
        products: productPayload,
        audiences: recommendedAudiences
      });
    } catch (error) {
      console.error(
        'Assistente PromoShop:',
        error.message
      );

      res
        .status(500)
        .json({
          error:
            'Não consegui consultar as ofertas agora. Tente novamente em alguns instantes.'
        });
    }
  }
);

/*
 * ==========================================================
 * FRONTEND
 * ==========================================================
 */

function publicSiteOrigin(config, req) {
  const configured = String(config?.canonicalUrl || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(configured);
    if (['http:', 'https:'].includes(url.protocol)) return url.origin;
  } catch { }
  return `${req.protocol}://${req.get('host')}`;
}

function xmlEscape(value) {
  return String(value || '').replace(/[<>&'\"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[character]));
}

function pageSeo(config, pathname, origin, offers = []) {
  const pages = {
    '/cupons': ['Cupons de desconto — PromoShop', 'Encontre cupons de desconto ativos e selecione uma oferta para ativar diretamente na loja.'],
    '/sobre': ['Sobre o PromoShop', 'Conheça o PromoShop, sua curadoria independente de ofertas e cupons de lojas parceiras.'],
    '/contato': ['Fale Conosco — PromoShop', 'Entre em contato com o PromoShop sobre ofertas, cupons, parcerias ou privacidade.'],
    '/termos-de-uso': ['Termos de Uso — PromoShop', 'Consulte as condições de uso, responsabilidades e transparência do PromoShop.'],
    '/privacidade': ['Política de Privacidade — PromoShop', 'Saiba como o PromoShop trata dados, consentimento, métricas e solicitações de privacidade.'],
    '/exclusao-de-dados': ['Exclusão de dados — PromoShop', 'Veja como solicitar a exclusão de dados e desconectar integrações do PromoShop.']
  };
  const offerMatch = pathname.match(/^\/oferta\/([^/]+)$/);
  const offer = offerMatch ? offers.find((entry) => offerPublicSlug(entry) === offerMatch[1]) : null;
  const categoryMatch = pathname.match(/^\/ofertas\/([^/]+)$/);
  const storeMatch = pathname.match(/^\/loja\/([^/]+)$/);
  const categoryName = categoryMatch ? offers.find((entry) => catalogSlug(entry.category) === categoryMatch[1])?.category : '';
  const storeName = storeMatch ? offers.find((entry) => catalogSlug(entry.store) === storeMatch[1])?.store : '';
  const page = offer
    ? [`${offer.title} — oferta no ${offer.store}`, `Confira preço, desconto e condições de ${offer.title}. A compra é concluída diretamente no ${offer.store}.`]
    : categoryName ? [`Ofertas de ${categoryName} — PromoShop`, `Compare ofertas selecionadas de ${categoryName} em lojas parceiras.`]
      : storeName ? [`Ofertas do ${storeName} — PromoShop`, `Veja ofertas e cupons selecionados do ${storeName}. Confirme as condições diretamente na loja.`]
        : pages[pathname];
  return {
    title: page?.[0] || String(config.seoTitle || `${config.brandName || 'PromoShop'} — Ofertas e cupons`),
    description: page?.[1] || String(config.seoDescription || ''),
    canonical: `${origin}${pathname === '/' ? '' : pathname}`,
    image: String(offer?.image || config.seoImageUrl || '').trim(),
    offer
  };
}

function injectSeo(html, data, req) {
  const config = data.config || {};
  const pathname = req.path.replace(/\/+$/, '') || '/';
  const origin = publicSiteOrigin(config, req);
  const seo = pageSeo(config, pathname, origin, data.offers || []);
  const siteName = String(config.seoSiteName || config.brandName || 'PromoShop').trim();
  const noIndex = pathname.startsWith('/admin') || pathname === '/favoritos' || config.seoIndexingEnabled === false;
  const schema = seo.offer ? {
    '@context': 'https://schema.org', '@type': 'Product', name: seo.offer.title,
    image: seo.offer.image ? [seo.offer.image] : undefined,
    description: seo.description,
    category: seo.offer.category || undefined,
    offers: { '@type': 'Offer', url: seo.canonical, priceCurrency: 'BRL', price: Number(seo.offer.price || 0).toFixed(2), availability: 'https://schema.org/InStock', seller: { '@type': 'Organization', name: seo.offer.store || 'Loja parceira' } }
  } : {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    alternateName: config.brandName || 'PromoShop',
    url: origin,
    description: seo.description,
    publisher: {
      '@type': 'Organization',
      name: config.brandName || 'PromoShop',
      url: origin,
      logo: `${origin}/favicon-512.png`,
      email: config.contactEmail || undefined
    }
  };
  const structuredData = config.seoStructuredDataEnabled === false || noIndex ? '' : `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
  const tags = [
    `<meta name="description" content="${escapeHtml(seo.description)}">`,
    `<meta name="keywords" content="${escapeHtml(config.seoKeywords || '')}">`,
    `<meta name="robots" content="${noIndex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large'}">`,
    `<link rel="canonical" href="${escapeHtml(seo.canonical)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(seo.title)}">`,
    `<meta property="og:description" content="${escapeHtml(seo.description)}">`,
    `<meta property="og:url" content="${escapeHtml(seo.canonical)}">`,
    seo.image ? `<meta property="og:image" content="${escapeHtml(seo.image)}">` : '',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(seo.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(seo.description)}">`,
    seo.image ? `<meta name="twitter:image" content="${escapeHtml(seo.image)}">` : '',
    '<link rel="manifest" href="/manifest.webmanifest">',
    structuredData
  ].filter(Boolean).join('\n    ');

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(seo.title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace('</head>', `    ${tags}\n  </head>`);
}

app.get('/robots.txt', async (req, res) => {
  const { config } = await readStore();
  const origin = publicSiteOrigin(config, req);
  res.type('text/plain').send(config.seoIndexingEnabled === false
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nSitemap: ${origin}/sitemap.xml\n`);
});

app.get('/sitemap.xml', async (req, res) => {
  const { config, offers } = await readStore();
  if (config.seoIndexingEnabled === false) return res.status(404).end();
  const origin = publicSiteOrigin(config, req);
  const lastmod = String(config.legalPolicyVersion || privacyPolicyVersion).slice(0, 10);
  const eligible = (offers || []).filter((offer) => publicOfferAllowed(offer, config));
  const paths = ['/', '/cupons', '/sobre', '/contato', '/termos-de-uso', '/privacidade', '/exclusao-de-dados'];
  const catalogPaths = [
    ...new Set(eligible.map((offer) => `/ofertas/${catalogSlug(offer.category)}`).filter((path) => !path.endsWith('/'))),
    ...new Set(eligible.map((offer) => `/loja/${catalogSlug(offer.store)}`).filter((path) => !path.endsWith('/'))),
    ...eligible.slice(0, 450).map((offer) => `/oferta/${offerPublicSlug(offer)}`)
  ];
  const urls = [...paths, ...catalogPaths].map((pathname) => `<url><loc>${xmlEscape(`${origin}${pathname === '/' ? '' : pathname}`)}</loc><lastmod>${xmlEscape(lastmod)}</lastmod></url>`).join('');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

app.get('/manifest.webmanifest', async (req, res) => {
  const { config } = await readStore();
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/manifest+json').send({
    name: config.brandName || 'PromoShop',
    short_name: config.brandName || 'PromoShop',
    description: config.seoDescription || '',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: config.primaryColor || '#1269f3',
    icons: [
      { src: '/favicon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/favicon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

app.use(
  express.static(
    path.join(
      root,
      'dist'
    ),
    {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      }
    }
  )
);

app.use(
  async (
    req,
    res,
    next
  ) => {
    if (
      req.path.startsWith(
        '/api'
      )
    ) {
      return next();
    }

    try {
      const [html, data] = await Promise.all([
        readIndexHtml(),
        readStore()
      ]);
      res.type('html').send(injectSeo(html, data, req));
    } catch (error) {
      next(error);
    }
  }
);

/*
 * ==========================================================
 * COLETA AUTOMÁTICA
 * ==========================================================
 */

cron.schedule('15 3 * * *', async () => {
  try {
    await updateStore((data) => pruneInboxEntries(data));
  } catch (error) {
    console.error('Falha ao aplicar a retenção da caixa de entrada:', error.message);
  }
});

cron.schedule('20 */6 * * *', async () => {
  try {
    const { config } = await readStore();
    if (config.linkCheckEnabled !== false) await runOfferLinkChecks();
  } catch (error) {
    console.error('Falha na verificação programada de links:', error.message);
  }
});

cron.schedule('30 4 * * *', async () => {
  try {
    const { config } = await readStore();
    await cleanupInstagramAssets(config.instagramAssetRetentionHours);
    const secrets = await readSecrets();
    const expiresAt = Number(secrets.instagramTokenExpiresAt || 0);
    if (secrets.instagramAccessToken && expiresAt && expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000) {
      await refreshInstagramToken(secrets);
      await addLog('Instagram: acesso renovado automaticamente.', 'success');
    }
  } catch (error) {
    await addLog(`Instagram: falha na manutenção automática: ${error.message}`, 'error');
  }
});

cron.schedule(
  '* * * * *',
  async () => {
    if (
      collectionInProgress
    ) {
      return;
    }

    const data =
      await readStore();

    const collectionRequested =
      Boolean(
        data.meta
          ?.collectionRequestedAt
      );

    const interval =
      Math.max(
        5,
        Number(
          data.config
            .collectionIntervalMinutes ||
          15
        )
      );

    const last =
      data.meta
        .lastCollectionAt
        ? new Date(
            data.meta
              .lastCollectionAt
          ).getTime()
        : 0;

    if (
      !collectionRequested &&
      Date.now() -
      last <
      interval *
      60_000
    ) {
      return;
    }

    try {
      await runCollectionWhenIdle();
    } catch (error) {
      await addLog(
        `Erro no agendador: ${error.message}`,
        'error'
      );
    }
  }
);

/*
 * ==========================================================
 * INICIALIZAÇÃO
 * ==========================================================
 */

app.listen(
  port,
  () => {
    console.log(
      `PromoShop API disponível em http://localhost:${port}`
    );

    setTimeout(
      async () => {
        try {
          const {
            config
          } =
            await readStore();

          if (
            whatsappAutoStartEnabled(
              config
            )
          ) {
            await startWhatsappWorker({
              automatic:
                true
            });
          }
        } catch (error) {
          await addLog(
            `Não foi possível iniciar o WhatsApp automaticamente: ${error.message}`,
            'error'
          );
        }
      },
      2000
    );

    const instagramTimer = setInterval(() => {
      processInstagramQueue().catch((error) => console.error('Instagram:', error.message));
    }, 30_000);
    instagramTimer.unref?.();
  }
);
