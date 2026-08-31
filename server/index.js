import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { Worker } from 'node:worker_threads';
import v8 from 'node:v8';

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import QRCode from 'qrcode';

import {
  addLog,
  checkStoreHealth,
  createId,
  readStore,
  readStoreSlice,
  updateStore
} from './store.js';

import {
  clearSessionCookies,
  createToken,
  hashSecurityIdentifier,
  requireAdmin,
  requireWorker,
  setSessionCookies
} from './auth.js';

import {
  collectAliexpress,
  collectMercadoLivre,
  collectShopee,
  applyCollectedOffers,
  makeQueueItem,
  searchMercadoLivreProducts,
  searchShopeeProducts
} from './collectors.js';

import {
  readSecrets,
  secretStatus,
  updateSecrets,
  verifyPassword,
  passwordNeedsRehash
} from './secrets.js';

import {
  classifyOfferAudience,
  generateFallbackOfferMessage,
  generateOfferMessage
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
import { buildWebsiteStructuredData, latestSeoDate } from './seoStructuredData.js';
import { stripAffiliateDisclosure } from './messageSanitizer.js';
import { buildGroupDirectoryMessage, sanitizeGroupDirectoryCodes } from './groupDirectory.js';
import {
  beginInstagramAuthorization,
  cleanupInstagramAssets,
  enqueueInstagramFeedFromWhatsapp,
  enqueueInstagramForCompletedWhatsappRound,
  enqueueInstagramFromWhatsapp,
  finishInstagramAuthorization,
  generateInstagramFeedAsset,
  generateInstagramHighlightAsset,
  generateInstagramShareTemplate,
  generateInstagramStory,
  instagramAssetPath,
  instagramPublishingState,
  instagramRateLimitUntil,
  processInstagramQueue,
  processInstagramFeedQueue,
  refreshInstagramToken,
  testInstagramConnection,
  verifyInstagramSignedRequest
} from './instagram.js';
import { sanitizeInstagramThemes } from './instagramThemes.js';
import { sanitizeInstagramHighlights } from './instagramHighlights.js';
import { createQueueSourceIndex, hasBlockingPendingSource, hasPendingSource, hasSentSource, hasSentSourceInLedger, queueItemSourceMatches, recordSentSourceInLedger } from './whatsappDedup.js';
import { terminateChildProcess } from './whatsappProcess.js';
import { getWhatsappRoundIntervalState } from './whatsappSchedule.js';
import { nextWhatsappStorePriorityCursor, normalizeWhatsappStorePriorityCursor, prioritizeWhatsappCandidates, WHATSAPP_STORE_PRIORITY } from './whatsappStorePriority.js';
import { safeRedirectDestination } from './urlSecurity.js';

const app = express();

app.set('x-powered-by', false);

const port = Number(
  process.env.PORT || 3001
);

function redirectWithinOrigin(res, status, origin, requestPath) {
  return res.redirect(status, safeRedirectDestination(origin, requestPath) || '/');
}

const root = path.resolve(
  path.dirname(
    fileURLToPath(import.meta.url)
  ),
  '..'
);

let indexHtmlPromise = null;

function collectOffersOutsideWebProcess() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./collectionWorker.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new Error('A coleta excedeu o tempo de segurança e foi encerrada.'));
    }, 12 * 60_000);
    timeout.unref?.();

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    worker.once('message', (message) => finish(() => {
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error || 'A coleta isolada falhou.'));
    }));
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`A coleta isolada foi encerrada sem retornar resultado (${code}).`)));
    });
  });
}

async function runCollectionIsolated() {
  return applyCollectedOffers(await collectOffersOutsideWebProcess());
}

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

function resolveWithin(promise, milliseconds, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

/*
 * Versão 7:
 *
 * - IA com fallback local.
 * - Roteamento local caso IA falhe.
 * - Rodada por público.
 * - 1 produto diferente para cada público.
 * - Intervalo configurado no painel entre publicações automáticas.
 */
const aiGenerationVersion = 7;

let whatsappProcess = null;
let whatsappRestartTimer = null;
let whatsappStopRequested = false;
let whatsappRestartAttempts = 0;
let whatsappReconnectPromise = null;
// Evita que o início automático, a reconexão solicitada pelo painel e o
// reinício após uma queda criem dois publicadores ao mesmo tempo.
let whatsappStartPromise = null;
const intentionallyStoppedWhatsappChildren = new WeakSet();
let collectionInProgress = false;
let lastDeferredCollectionRoundId = '';
const extensionRateLimit = new Map();
const WHATSAPP_HEARTBEAT_PERSIST_MS = 2 * 60_000;
let whatsappRuntimeState = null;
let whatsappHeartbeatPersistedAt = 0;

function updateWhatsappRuntime(patch = {}, now = new Date()) {
  whatsappRuntimeState = {
    ...(whatsappRuntimeState || {}),
    ...patch,
    lastSeenAt: patch.lastSeenAt || now.toISOString()
  };
  return whatsappRuntimeState;
}

function effectiveWhatsappState(data = {}, now = Date.now()) {
  const persisted = data.meta?.whatsapp || {};
  const persistedAt = new Date(persisted.lastSeenAt || 0).getTime();
  const runtimeAt = new Date(whatsappRuntimeState?.lastSeenAt || 0).getTime();
  // QR e código de pareamento não são persistidos. Enquanto uma dessas
  // credenciais temporárias existir na memória, ela precisa prevalecer mesmo
  // que a gravação do status no banco tenha ocorrido alguns milissegundos depois.
  const hasRuntimeCredential = Boolean(
    whatsappRuntimeState?.qrDataUrl || whatsappRuntimeState?.pairingCode
  );
  const current = (hasRuntimeCredential || runtimeAt >= persistedAt) && whatsappRuntimeState
    ? { ...persisted, ...whatsappRuntimeState }
    : { ...persisted };
  const lastSeenAt = new Date(current.lastSeenAt || 0).getTime();
  if (current.status === 'connected' && (!Number.isFinite(lastSeenAt) || now - lastSeenAt > 90_000)) {
    current.status = 'offline';
  }
  return current;
}

function appendStoreLog(data, message, level = 'info') {
  data.logs ||= [];
  data.logs.unshift({
    id: createId('log'),
    message,
    level,
    createdAt: new Date().toISOString()
  });
  data.logs = data.logs.slice(0, 200);
}

function releaseInstagramAfterWhatsappRound(data, round) {
  if (!round?.id || round.instagramReleasedAt) return { stories: [], feed: [], processed: 0 };
  const released = enqueueInstagramForCompletedWhatsappRound(data, round.id);
  round.instagramReleasedAt = new Date().toISOString();
  if (released.stories.length || released.feed.length) {
    appendStoreLog(
      data,
      `Instagram: rodada ${round.id} concluída no WhatsApp; ${released.stories.length} Story(s) e ${released.feed.length} publicação(ões) do Feed foram liberados para seus próprios intervalos.`,
      'success'
    );
  }
  return released;
}

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
  allowOutsidePublishingWindow = false,
  ignorePublicationRound = false
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

    const bypassRoundWait = ignorePublicationRound || manualOutsideSchedule;

    if (round && !bypassRoundWait) {
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

    if (round && bypassRoundWait) {
      await addLog(
        ignorePublicationRound
          ? 'Coleta manual iniciada com pausa temporária da rodada de publicação; a rodada existente será retomada ao finalizar.'
          : 'Coleta manual iniciada fora do horário de publicação; a rodada existente foi mantida.',
        'info'
      );
    }

    const result =
      await runCollectionIsolated();

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
      queued: false,
      pausedRound: Boolean(ignorePublicationRound && round)
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
const consentAttempts = new Map();
const consentWindowMs = 15 * 60 * 1000;
const consentMaxAttempts = 12;
let legacyAdminPasswordDetected = null;

// O Render termina o TLS antes do Node; em desenvolvimento não confiamos em
// X-Forwarded-* enviado diretamente pelo cliente.
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production' || req.path === '/api/health') return next();
  // A Meta busca essas imagens pelo domínio nativo do Render. Não redirecione
  // o arquivo para o domínio público/CDN, pois o crawler precisa receber o JPEG
  // diretamente na mesma URL informada ao criar o container.
  if (req.path.startsWith('/media/instagram/')) return next();
  let canonical;
  try { canonical = new URL(process.env.SITE_URL || process.env.PUBLIC_URL || 'https://promoshop.jhonatafaraujo.com.br'); }
  catch { return next(); }
  const requestHost = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim().toLowerCase();
  if (!canonical.hostname || !requestHost || requestHost === canonical.host.toLowerCase() || /^localhost(?::\d+)?$/.test(requestHost) || /^127\.0\.0\.1(?::\d+)?$/.test(requestHost)) return next();
  if (['GET', 'HEAD'].includes(req.method)) return redirectWithinOrigin(res, 308, canonical.origin, req.originalUrl);
  return res.status(421).json({ error: 'Use o endereço oficial do PromoShop.' });
});

/*
 * ==========================================================
 * SEGURANÇA / LIMITES
 * ==========================================================
 */

function pruneRateMap(map, now = Date.now(), maximum = 5000) {
  for (const [key, value] of map) {
    if (value?.resetAt && value.resetAt <= now) map.delete(key);
  }
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function loginAttemptState(ip) {
  const now = Date.now();
  pruneRateMap(loginAttempts, now);

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

function persistentLoginKey(ip) {
  return hashSecurityIdentifier(ip);
}

async function persistentLoginAttemptState(ip) {
  const { meta } = await readStoreSlice(['meta']);
  const key = persistentLoginKey(ip);
  const state = meta?.security?.loginAttempts?.[key];
  if (!state || Number(state.resetAt || 0) <= Date.now()) return { count: 0, resetAt: Date.now() + loginWindowMs, blockedUntil: 0 };
  return {
    count: Number(state.count || 0),
    resetAt: Number(state.resetAt || 0),
    blockedUntil: Number(state.blockedUntil || 0)
  };
}

async function registerPersistentFailedLogin(ip) {
  const key = persistentLoginKey(ip);
  const now = Date.now();
  await updateStore((data) => {
    data.meta ||= {};
    data.meta.security ||= {};
    const attempts = data.meta.security.loginAttempts ||= {};
    for (const [storedKey, state] of Object.entries(attempts)) {
      if (Number(state?.resetAt || 0) <= now) delete attempts[storedKey];
    }
    const current = attempts[key]?.resetAt > now
      ? attempts[key]
      : { count: 0, resetAt: now + loginWindowMs, blockedUntil: 0 };
    current.count = Number(current.count || 0) + 1;
    if (current.count >= loginMaxAttempts) current.blockedUntil = now + loginWindowMs;
    attempts[key] = current;
    const keys = Object.keys(attempts);
    if (keys.length > 500) {
      keys.sort((left, right) => Number(attempts[left]?.resetAt || 0) - Number(attempts[right]?.resetAt || 0));
      keys.slice(0, keys.length - 500).forEach((storedKey) => delete attempts[storedKey]);
    }
  });
}

async function clearPersistentLoginAttempts(ip) {
  const key = persistentLoginKey(ip);
  await updateStore((data) => {
    if (data.meta?.security?.loginAttempts) delete data.meta.security.loginAttempts[key];
  });
}

function checkAssistantLimit(ip) {
  const now = Date.now();
  pruneRateMap(assistantAttempts, now);

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
  pruneRateMap(contactAttempts, now);
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
  pruneRateMap(analyticsAttempts, now);
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

function safeErrorMessage(error, fallback = 'Erro interno.') {
  const raw = String(error?.message || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!raw) return fallback;
  return raw
    .replace(
      /(api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|password|cookie|csrf)[^,; ]*/gi,
      (_matchedValue, sensitiveLabel) => `${sensitiveLabel}=[redacted]`
    )
    .slice(0, 300);
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
  const configured = String(process.env.PUBLIC_URL || process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '')
    .split(',')[0].trim().replace(/\/$/, '');
  if (/^https:\/\//i.test(configured)) return configured;
  if (process.env.NODE_ENV === 'production') return 'https://promoshop.jhonatafaraujo.com.br';
  const host = String(req.get('host') || '').split(',')[0].trim();
  return /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/i.test(host)
    ? `${req.protocol || 'http'}://${host}`
    : `http://localhost:${port}`;
}

function checkConsentLimit(ip) {
  const now = Date.now();
  pruneRateMap(consentAttempts, now);
  const key = hashSecurityIdentifier(ip);
  const current = consentAttempts.get(key) || { count: 0, resetAt: now + consentWindowMs };
  if (current.resetAt <= now) {
    current.count = 0;
    current.resetAt = now + consentWindowMs;
  }
  if (current.count >= consentMaxAttempts) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  consentAttempts.set(key, current);
  return { allowed: true };
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`O serviço externo não respondeu em ${Math.round(timeoutMs / 1000)} segundos.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function validClockTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function publicOfferTotal(offers, config, nowMs = Date.now()) {
  const eligible = (Array.isArray(offers) ? offers : [])
    .filter((offer) => publicOfferAllowed(offer, config, nowMs));

  if (config.duplicateGroupingEnabled === false) return eligible.length;

  return new Set(
    eligible.map((offer) => productFingerprint(offer) || String(offer.id || ''))
  ).size;
}

function catalogSlug(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

// Somente categorias amplas e reconhecíveis viram filtros e páginas de SEO.
// Algumas APIs de afiliados já devolveram o nome do vendedor ou da coleção
// no campo de categoria; indexar esses valores cria páginas fracas e duplicadas.
const publicCategorySlugs = new Set([
  'acessorios-para-veiculos',
  'agro',
  'alimentos-e-bebidas',
  'antiguidades-e-colecoes',
  'arte-papelaria-e-armarinho',
  'bebes',
  'beleza-e-cuidado-pessoal',
  'brinquedos-e-hobbies',
  'calcados-roupas-e-bolsas',
  'cameras-e-acessorios',
  'casa-e-cozinha',
  'casa-moveis-e-decoracao',
  'celulares-e-telefones',
  'construcao',
  'eletrodomesticos',
  'eletronicos-audio-e-video',
  'esporte-e-fitness',
  'esportes-e-fitness',
  'ferramentas',
  'ferramentas-e-automotivo',
  'festas-e-lembrancinhas',
  'games',
  'industria-e-comercio',
  'informatica',
  'instrumentos-musicais',
  'joias-e-relogios',
  'livros-revistas-e-comics',
  'musica-filmes-e-seriados',
  'pet-shop',
  'saude',
  'supermercado',
  'tecnologia',
  'tecnologia-e-games',
  'beleza-e-cabelo',
  'moda-e-acessorios',
  'bebes-e-criancas'
]);

function publicCategoryAllowed(value) {
  return publicCategorySlugs.has(catalogSlug(value));
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
  'ser', 'trabalhar', 'trabalho', 'uma', 'um', 'usar', 'uso', 'valor', 'ver',
  'cupom', 'cupons', 'codigo', 'codigos', 'desconto', 'descontos', 'off'
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

function assistantCouponIntent(value) {
  const normalized = normalizeSearchText(value);
  return /\bcupom\b|\bcupons\b|\bcodigo(?:s)?\b|\bpromocode\b|\bdesconto\s+(?:para|na|no|da|do)\b/.test(normalized);
}

function publicCouponAllowed(coupon, nowMs = Date.now()) {
  if (!coupon || coupon.active === false) return false;
  if (coupon.source === 'extension' && coupon.approvalStatus !== 'approved') return false;
  if (!coupon.expiresAt) return true;
  const expiresAt = new Date(coupon.expiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt >= nowMs;
}

function assistantCoupons(query, coupons, { store = '', seenCouponIds = new Set() } = {}) {
  const normalizedStore = normalizeSearchText(store);
  const queryTokens = normalizeSearchText(query).split(/\s+/).filter((token) => token.length >= 2 && !assistantIgnoredWords.has(token));
  const ranked = (Array.isArray(coupons) ? coupons : [])
    .filter((coupon) => !seenCouponIds.has(String(coupon.id || '')))
    .filter((coupon) => !normalizedStore || normalizeSearchText(coupon.store).includes(normalizedStore))
    .map((coupon) => {
      const searchable = normalizeSearchText(`${coupon.title || ''} ${coupon.description || ''} ${coupon.store || ''} ${coupon.code || ''}`);
      const matches = queryTokens.filter((token) => searchable.includes(token));
      if (queryTokens.length && !matches.length) return null;
      const discount = Number(coupon.discountValue || 0);
      const discountScore = coupon.discountType === 'fixed' ? Math.min(35, discount / 2) : Math.min(35, discount);
      const expiry = coupon.expiresAt ? new Date(coupon.expiresAt).getTime() : 0;
      const daysLeft = expiry ? Math.max(0, (expiry - Date.now()) / 86400000) : 30;
      return { coupon, score: matches.length * 40 + discountScore + (coupon.featured ? 10 : 0) + Math.max(0, 10 - daysLeft / 3) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || new Date(b.coupon.createdAt || 0) - new Date(a.coupon.createdAt || 0))
    .slice(0, 4)
    .map(({ coupon }) => coupon);
  return ranked;
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
  'shope.ee',
  'aliexpress.com',
  'aliexpress.com.br',
  'a.aliexpress.com',
  'magalu.com',
  'magazinevoce.com.br',
  'magazineluiza.com.br',
  'netshoes.com.br'
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
  if (item?.kind === 'coupon' || item?.kind === 'group-directory') {
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

function normalizeInstagramProfileUrl(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let username = raw.replace(/^@/, '');

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.toLowerCase();
      if (
        parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !['instagram.com', 'www.instagram.com'].includes(hostname)
      ) return fallback;
      username = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      return fallback;
    }
  }

  username = username.replace(/^@/, '');
  if (!/^[a-z0-9._]{1,30}$/i.test(username)) return fallback;
  if (['accounts', 'direct', 'explore', 'p', 'reel', 'reels', 'stories'].includes(username.toLowerCase())) return fallback;
  return `https://www.instagram.com/${username}/`;
}

function hasSentSourceInStore(data, candidate, sourceIndex = null) {
  return hasSentSource(data?.queue, candidate, sourceIndex) || hasSentSourceInLedger(data, candidate);
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

  // O worker faz esta consulta com frequência. Sem criação de rodada, ela
  // deve ser somente leitura para não abrir transações ou copiar o estado.
  if (!createIfMissing) {
    const data = await readStore();
    const round = data.meta?.publicationRound;
    if (!round || !Array.isArray(round.pendingAudienceCodes)) return null;
    const availableCodes = getRoundAudienceCodes(data);
    const pendingAudienceCodes = round.pendingAudienceCodes
      .map(normalizeAudienceCode)
      .filter((code) => availableCodes.includes(code));
    if (!pendingAudienceCodes.length) return null;
    return {
      id: round.id,
      pendingAudienceCodes,
      usedOfferIds: Array.isArray(round.usedOfferIds) ? [...round.usedOfferIds] : [],
      storePriorityCursor: normalizeWhatsappStorePriorityCursor(round.storePriorityCursor)
    };
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

          usedOfferIds: [],

          storePriorityCursor: 0
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

        round.storePriorityCursor = normalizeWhatsappStorePriorityCursor(round.storePriorityCursor);

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
          ],

        storePriorityCursor: normalizeWhatsappStorePriorityCursor(round.storePriorityCursor)
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

        releaseInstagramAfterWhatsappRound(data, round);

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
  [
    process.env.SITE_URL,
    process.env.PUBLIC_URL,
    'https://promoshop.jhonatafaraujo.com.br'
  ].join(',')
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
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const isHttps = req.secure || forwardedProto === 'https';
    if (process.env.NODE_ENV === 'production' && !isHttps && req.method !== 'OPTIONS') {
      const host = String(req.get('host') || '').split(',')[0].trim();
      if (host && !/^localhost(?::\d+)?$/i.test(host) && !/^127\.0\.0\.1(?::\d+)?$/.test(host)) {
        return redirectWithinOrigin(res, 308, requestBaseUrl(req), req.originalUrl);
      }
    }

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

    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'"
    );

    if (isHttps) {
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

app.use((req, res, next) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > 1_048_576) return res.status(413).json({ error: 'A solicitação excede o limite permitido.' });
  next();
});

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

async function startWhatsappWorkerUnlocked({
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
        detached: process.platform !== 'win32',
        stdio: 'inherit'
      }
    );

  whatsappProcess =
    child;

  // O Chromium é o processo mais pesado do serviço. Mantê-lo com prioridade
  // menor garante que as rotas HTTP e o painel continuem respondendo mesmo
  // durante autenticação, sincronização de grupos ou carregamento de mídias.
  try {
    setPriority(child.pid, 10);
  } catch {
    // Alguns ambientes não permitem alterar a prioridade; o worker continua.
  }

  updateWhatsappRuntime({
    status: 'starting',
    qrDataUrl: null,
    pairingCode: null,
    message: automatic
      ? 'Restaurando a conexão do WhatsApp…'
      : mode === 'phone'
        ? 'Gerando código de pareamento…'
        : 'Gerando QR Code…'
  });

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

      if (whatsappRuntimeState?.status !== 'error') {
        updateWhatsappRuntime({
          status: 'offline',
          message: `Publicador encerrado (${code ?? 'sem código'}).`
        });
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
        intentionallyStoppedWhatsappChildren.has(child) ||
        !whatsappAutoStartEnabled(config)
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

async function startWhatsappWorker(options = {}) {
  if (whatsappStartPromise) return whatsappStartPromise;

  whatsappStartPromise = startWhatsappWorkerUnlocked(options);
  try {
    return await whatsappStartPromise;
  } finally {
    whatsappStartPromise = null;
  }
}

async function stopWhatsappWorkerProcess() {
  if (whatsappRestartTimer) clearTimeout(whatsappRestartTimer);
  whatsappRestartTimer = null;

  const child = whatsappProcess;
  if (!child || child.exitCode !== null) {
    if (whatsappProcess === child) whatsappProcess = null;
    return { exited: true, forced: false };
  }

  whatsappStopRequested = true;
  intentionallyStoppedWhatsappChildren.add(child);
  const result = await terminateChildProcess(child, {
    processGroup: process.platform !== 'win32'
  });
  if (whatsappProcess === child) whatsappProcess = null;
  return result;
}

async function reconnectWhatsappWorker() {
  if (whatsappReconnectPromise) return whatsappReconnectPromise;
  whatsappReconnectPromise = (async () => {
    const stopped = await stopWhatsappWorkerProcess();
    if (!stopped.exited) throw new Error('O publicador anterior não encerrou corretamente. Tente novamente em alguns segundos.');
    // Uma inicialização automática pode ter começado no mesmo instante em que
    // o painel solicitou a reconexão. Espere essa operação terminar antes de
    // criar o novo processo, evitando matar o processo recém-criado e depois
    // reutilizar uma promessa já concluída.
    const pendingStart = whatsappStartPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    whatsappStopRequested = false;
    whatsappRestartAttempts = 0;
    return startWhatsappWorker({ mode: 'qr', automatic: true });
  })();
  try {
    return await whatsappReconnectPromise;
  } finally {
    whatsappReconnectPromise = null;
  }
}

function reportWhatsappReconnectFailure(error) {
  const message = `Não foi possível reconectar o WhatsApp: ${safeErrorMessage(error, 'o publicador não encerrou corretamente')}`;
  updateWhatsappRuntime({ status: 'error', qrDataUrl: null, pairingCode: null, message });
  void updateStore((data) => {
    data.meta.whatsapp = {
      ...data.meta.whatsapp,
      status: 'error',
      qrDataUrl: null,
      pairingCode: null,
      message,
      lastSeenAt: new Date().toISOString()
    };
    appendStoreLog(data, `WhatsApp: ${message}`, 'error');
  }).catch((storeError) => console.error('Falha ao salvar erro de reconexão:', storeError.message));
}



/*
 * ==========================================================
 * ROTAS PÚBLICAS
 * ==========================================================
 */

app.get(
  '/api/health',
  async (_req, res) => {
    const databaseOk = await resolveWithin(checkStoreHealth(), 2_500, false);
    const status = databaseOk ? 200 : 503;
    res.status(status).json({
      ok: databaseOk,
      time: new Date().toISOString(),
      services: { database: databaseOk ? 'ok' : 'unavailable' }
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
  'brandName', 'heroTitle', 'heroText', 'primaryColor', 'whatsappUrl', 'instagramUrl',
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
    .filter((coupon) => publicCouponAllowed(coupon, now))
    .sort((a, b) => Number(b.featured) - Number(a.featured) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 6)
    .map((coupon) => publicCouponPayload(coupon, req));
}

function publicCouponDescription(coupon) {
  const fallbackDiscount = coupon.discountType === 'fixed'
    ? `R$ ${Number(coupon.discountValue || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} OFF`
    : coupon.discountType === 'free-shipping'
      ? 'Frete grátis'
      : Number(coupon.discountValue || 0) > 0
        ? `${Number(coupon.discountValue)}% OFF`
        : 'Desconto';
  const rawDescription = String(coupon.description || '');
  const fallbackDescription = `${fallbackDiscount} em produtos selecionados.`;
  // Alguns cards do Mercado Livre chegam com todo o texto da tela, inclusive
  // orçamento da campanha e outros cupons. Nunca exponha esse conteúdo público.
  if (/Cupons disponíveis|Códigos gerados|Orçamento restante|Seu código|Copiar código|Condições do cupom/i.test(rawDescription)) {
    return fallbackDescription;
  }
  const cleaned = rawDescription
    .replace(/\bOrçamento restante\s*:?\s*R\$\s*[\d.\s,]+/gi, ' ')
    .replace(/\b(?:Condições do cupom|Copiar código|Ver produtos|Seu código)\b\s*:?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const description = cleaned || fallbackDescription;
  return description.length > 180 ? `${description.slice(0, 177).trimEnd()}…` : description;
}

function publicCouponPayload(coupon, req) {
  return {
    id: String(coupon.id || ''),
    title: String(coupon.title || '').trim(),
    store: String(coupon.store || '').trim(),
    code: String(coupon.code || '').trim(),
    description: publicCouponDescription(coupon),
    discountType: String(coupon.discountType || 'percent'),
    discountValue: Number(coupon.discountValue || 0),
    minPurchase: Number(coupon.minPurchase || 0),
    expiresAt: coupon.expiresAt || null,
    image: String(coupon.image || '').trim(),
    featured: Boolean(coupon.featured),
    shortUrl: couponShortUrl(coupon, req)
  };
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

function publicOfferPayload(offer, config, analytics) {
  const affiliate = safeAffiliateDestination(offer.affiliateUrl);
  const product = safeAffiliateDestination(offer.productUrl);
  return {
    id: String(offer.id || ''),
    title: String(offer.title || '').trim(),
    store: String(offer.store || '').trim(),
    category: String(offer.category || '').trim(),
    price: Number(offer.price || 0),
    originalPrice: Number(offer.originalPrice || 0),
    image: String(offer.image || '').trim(),
    affiliateUrl: affiliate?.toString() || '',
    productUrl: product?.toString() || '',
    freeShipping: Boolean(offer.freeShipping),
    featured: Boolean(offer.featured),
    createdAt: offer.createdAt || null,
    updatedAt: offer.updatedAt || null,
    publicSlug: offerPublicSlug(offer),
    qualityScore: offerQuality(offer, config).score,
    rankingScore: analytics ? smartOfferScore(offer, config, analytics, Date.now()) : undefined
  };
}

app.get('/api/home', async (req, res) => {
  const data = await readStoreSlice(['config', 'coupons']);
  const activeCoupons = (Array.isArray(data.coupons) ? data.coupons : []).filter((coupon) => publicCouponAllowed(coupon));
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
    const { offers, config, analytics } = await readStoreSlice(['offers', 'config', 'analytics']);
    const nowMs = Date.now();
    const eligible = (Array.isArray(offers) ? offers : [])
      .filter((offer) => publicOfferAllowed(offer, config, nowMs));

    if (String(req.query?.paged || '') !== '1') {
      // Compatibilidade com consumidores antigos, porém com limite rígido.
      // A vitrine atual usa a resposta paginada abaixo.
      res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      return res.json(
        eligible
          .sort((a, b) => Number(b.featured) - Number(a.featured))
          .slice(0, 60)
          .map((offer) => publicOfferPayload(offer, config, analytics))
      );
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
    const categories = [...new Set(eligible.map((offer) => String(offer.category || '').trim()).filter(publicCategoryAllowed))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const requestedCategoryAllowed = !category || publicCategoryAllowed(category);
    let filtered = eligible.filter((offer) => {
      const searchable = `${offer.title || ''} ${offer.store || ''} ${offer.category || ''}`.toLocaleLowerCase('pt-BR');
      const price = Number(offer.price || 0);
      return requestedCategoryAllowed
        && (!query || searchable.includes(query))
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

    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    return res.json({
      offers: filtered.slice(offset, offset + limit).map((offer) => publicOfferPayload(offer, config, analytics)),
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
  const { offers, config } = await readStoreSlice(['offers', 'config']);
  const eligible = (offers || []).filter((offer) => publicOfferAllowed(offer, config));
  const countBy = (key, predicate = () => true) => Object.values(eligible.reduce((map, offer) => {
    const name = String(offer[key] || '').trim();
    if (!name || !predicate(name)) return map;
    map[name] ||= { name, slug: catalogSlug(name), count: 0 };
    map[name].count += 1;
    return map;
  }, {})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ stores: countBy('store'), categories: countBy('category', publicCategoryAllowed) });
});

app.get('/api/search/suggestions', async (req, res) => {
  const query = String(req.query?.q || '').trim().toLocaleLowerCase('pt-BR').slice(0, 80);
  if (query.length < 2) return res.json([]);
  const { offers, config } = await readStoreSlice(['offers', 'config']);
  const suggestions = (offers || []).filter((offer) => publicOfferAllowed(offer, config) && `${offer.title} ${offer.store} ${offer.category}`.toLocaleLowerCase('pt-BR').includes(query))
    .slice(0, 8).map((offer) => ({ title: offer.title, store: offer.store, slug: offerPublicSlug(offer) }));
  res.set('Cache-Control', 'public, max-age=60');
  res.json(suggestions);
});

app.get('/api/offer/:slug', async (req, res) => {
  const { offers, config, analytics } = await readStoreSlice(['offers', 'config', 'analytics']);
  const eligible = (offers || []).filter((offer) => publicOfferAllowed(offer, config));
  const offer = eligible.find((entry) => offerPublicSlug(entry) === req.params.slug);
  if (!offer) return res.status(404).json({ error: 'Oferta não encontrada ou não está mais disponível.' });
  const fingerprint = productFingerprint(offer);
  const comparisons = eligible.filter((entry) => entry.id !== offer.id && productFingerprint(entry) === fingerprint)
    .sort((a, b) => Number(a.price || 0) - Number(b.price || 0)).slice(0, 6);
  const related = eligible.filter((entry) => entry.id !== offer.id && entry.category === offer.category && !comparisons.some((item) => item.id === entry.id))
    .sort((a, b) => smartOfferScore(b, config, analytics) - smartOfferScore(a, config, analytics)).slice(0, 6);
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  res.json({ offer: publicOfferPayload(offer, config, analytics), comparisons: comparisons.map((entry) => publicOfferPayload(entry, config, analytics)), related: related.map((entry) => publicOfferPayload(entry, config, analytics)) });
});

app.get(
  '/api/coupons',
  async (req, res) => {
    const { coupons } = await readStoreSlice(['coupons']);
    const now = Date.now();

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');

    res.json(
      (Array.isArray(coupons) ? coupons : [])
        .filter((coupon) => publicCouponAllowed(coupon, now))
        .sort((a, b) => Number(b.featured) - Number(a.featured) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 300)
        .map((coupon) => publicCouponPayload(coupon, req))
    );
  }
);

app.get(
  '/c/:code',
  async (req, res) => {
    const code = String(req.params.code || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{4,80}$/.test(code)) return res.status(404).send('Cupom não encontrado.');

    const { coupons } = await readStoreSlice(['coupons']);
    const coupon = (Array.isArray(coupons) ? coupons : []).find((entry) => couponShortCode(entry) === code);
    if (!coupon || coupon.active === false) return res.status(404).send('Cupom não encontrado ou inativo.');

    if (coupon.expiresAt) {
      const expiresAt = new Date(coupon.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return res.status(410).send('Este cupom expirou.');
    }

    const destination = safeAffiliateDestination(coupon.link);
    if (!destination) return res.status(404).send('Link do cupom indisponível.');

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
      const brevoResponse = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
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
      }, 15_000);

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
      const brevoResponse = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
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
      }, 15_000);

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

    let brevoResponse = await fetchWithTimeout(endpoint, {
      method,
      headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }, 15_000);

    if (!brevoResponse.ok && method === 'PUT' && brevoResponse.status === 404) {
      brevoResponse = await fetchWithTimeout('https://api.brevo.com/v3/webhooks', {
        method: 'POST',
        headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }, 15_000);
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
      data.config.inboxInboundWebhookUrl = `${requestBaseUrl(req)}/api/webhooks/brevo/inbound`;
    });
    await addLog(`Recebimento de respostas por e-mail ativado em ${domain}.`, 'success');

    res.json({
      ok: true,
      domain,
      webhookUrl: `${requestBaseUrl(req)}/api/webhooks/brevo/inbound`,
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
    const rate = checkConsentLimit(req.ip || req.socket.remoteAddress || 'unknown');
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ error: 'Muitas atualizações de privacidade. Aguarde alguns minutos.' });
    }
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
    const allowedTypes = ['offer', 'coupon', 'whatsapp', 'instagram', 'group', 'favorite'];

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

    const memoryAttemptState = loginAttemptState(clientIp);
    const storedAttemptState = await persistentLoginAttemptState(clientIp);
    const attemptState = {
      count: Math.max(memoryAttemptState.count, storedAttemptState.count),
      resetAt: Math.max(memoryAttemptState.resetAt, storedAttemptState.resetAt),
      blockedUntil: Math.max(memoryAttemptState.blockedUntil, storedAttemptState.blockedUntil)
    };

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

    if (legacyAdminPasswordDetected === null) {
      legacyAdminPasswordDetected = await verifyPassword('admin123', secrets.adminPasswordHash);
    }
    if (legacyAdminPasswordDetected) {
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
      legacyAdminPasswordDetected = false;
    }

    const username = String(req.body?.username || '').trim().slice(0, 100);
    const password = String(req.body?.password || '').slice(0, 256);
    if (!username || !password) {
      return res.status(400).json({ error: 'Informe usuário e senha.' });
    }

    const expectedUser =
      process.env
        .ADMIN_USER ||
      secrets.adminUser;

    const userOk =
      String(
        username ||
        ''
      ) === expectedUser;

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
        ? await verifyPassword(
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
      await registerPersistentFailedLogin(clientIp);

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
    await clearPersistentLoginAttempts(clientIp);

    if (secrets.adminPasswordHash && passwordNeedsRehash(secrets.adminPasswordHash)) {
      secrets = await updateSecrets({ rehashAdminPassword: password });
    }

    const token = createToken(expectedUser, secrets.adminSessionVersion);
    setSessionCookies(res, token);
    res.json({ authenticated: true });
  }
);

app.get('/api/auth/session', requireAdmin, (_req, res) => {
  res.json({ authenticated: true });
});

app.post('/api/auth/logout', requireAdmin, (_req, res) => {
  clearSessionCookies(res);
  res.json({ ok: true });
});

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

function summarizeQueue(queue = [], historicalSent = 0) {
  const summary = { total: 0, pending: 0, publishing: 0, sent: 0, failed: 0, skipped: 0 };
  for (const item of Array.isArray(queue) ? queue : []) {
    summary.total += 1;
    if (Object.hasOwn(summary, item?.status)) summary[item.status] += 1;
  }
  summary.sent += Math.max(0, Number(historicalSent) || 0);
  return summary;
}

app.get('/api/admin/queue', requireAdmin, async (req, res) => {
  const data = await readStore();
  const queue = Array.isArray(data.queue) ? data.queue : [];
  const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(req.query.limit) || 50)));
  res.json({
    items: queue.slice(offset, offset + limit).map(adminQueueItem),
    offset,
    limit,
    hasMore: offset + limit < queue.length,
    summary: summarizeQueue(queue, data.meta?.whatsappSentHistoryCount)
  });
});

app.get('/api/admin/instagram-state', requireAdmin, async (_req, res) => {
  const data = await readStoreSlice(['instagramQueue', 'instagramFeedQueue', 'logs', 'meta']);
  const rateLimitedTimestamp = instagramRateLimitUntil(data);
  const rateLimitedUntil = rateLimitedTimestamp > Date.now()
    ? new Date(rateLimitedTimestamp).toISOString()
    : null;
  res.json({
    instagramQueue: (data.instagramQueue || []).slice(-200),
    instagramFeedQueue: (data.instagramFeedQueue || []).slice(-200),
    logs: (data.logs || []).slice(0, 200),
    meta: {
      instagramRateLimitedUntil: rateLimitedUntil,
      instagramFeedRateLimitedUntil: rateLimitedUntil
    }
  });
});

app.get('/api/admin/inbox-state', requireAdmin, async (_req, res) => {
  const data = await readStoreSlice(['inbox', 'logs']);
  res.json({ inbox: data.inbox || [], logs: (data.logs || []).slice(0, 200) });
});

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

    const dashboardData = {
      ...data,
      meta: {
        ...(data.meta || {}),
        whatsapp: effectiveWhatsappState(data)
      }
    };

    // O painel não precisa receber comprovantes de consentimento nem o
    // ledger permanente de deduplicação. Esses objetos crescem ao longo do
    // tempo e, além de sensíveis, tornavam cada abertura do painel maior.
    const {
      privacyConsents: _privacyConsents,
      inbox: _inbox,
      instagramQueue: _instagramQueue,
      instagramFeedQueue: _instagramFeedQueue,
      meta: dashboardMeta,
      ...dashboardPayload
    } = dashboardData;
    const safeDashboardMeta = {
      lastCollectionAt: dashboardMeta?.lastCollectionAt || null,
      collectionRequestedAt: dashboardMeta?.collectionRequestedAt || null,
      publicationRound: dashboardMeta?.publicationRound || null,
      lastPublicationRound: dashboardMeta?.lastPublicationRound || null,
      whatsapp: dashboardMeta?.whatsapp || {}
    };

    res.json({
      ...dashboardPayload,
      meta: safeDashboardMeta,
      publicOfferTotal: publicOfferTotal(
        dashboardData.offers,
        dashboardData.config
      ),
      offers: (Array.isArray(dashboardData.offers) ? dashboardData.offers : []).map((offer) => {
        const quality = offerQuality(offer, dashboardData.config);
        return {
          ...offer,
          publicSlug: offerPublicSlug(offer),
          qualityScore: quality.score,
          qualityIssues: quality.issues,
          isStale: !offerIsFresh(offer, dashboardData.config)
        };
      }),
      // O resumo inicial precisa apenas das próximas publicações. A aba da
      // fila carrega páginas de 50 itens por uma rota dedicada.
      queue: (Array.isArray(dashboardData.queue) ? dashboardData.queue : [])
        .filter((item) => item?.status === 'pending')
        .slice(0, 5)
        .map(adminQueueItem),
      queueSummary: summarizeQueue(dashboardData.queue, dashboardMeta?.whatsappSentHistoryCount),
      inbox: [],
      instagramQueue: [],
      instagramFeedQueue: [],
      coupons: (Array.isArray(dashboardData.coupons) ? dashboardData.coupons : []).map((coupon) => ({
        ...coupon,
        shortCode: couponShortCode(coupon),
        shortUrl: couponShortUrl(coupon, req)
      })),

      analytics:
        summarizeAnalytics(
          dashboardData.analytics
        ),

      systemHealth:
        summarizeSystemHealth(
          dashboardData
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

        // Aceita somente chaves que já fazem parte da configuração. Isso
        // impede mass assignment de campos internos (fila, metadados etc.).
        const configPatch = Object.fromEntries(
          Object.entries(body).filter(([key]) => Object.prototype.hasOwnProperty.call(data.config, key) && !['__proto__', 'constructor', 'prototype'].includes(key))
        );
        data.config = {
          ...data.config,
          ...configPatch
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
          minDiscount: [20, 0, 99],
          maxPostsPerDay: [100, 1, 5000],
          maxPostsPerAudiencePerDay: [10, 1, 500],
          collectionIntervalMinutes: [15, 5, 1440],
          whatsappMaxPerHour: [100, 1, 500],
          whatsappIntervalMinutes: [15, 1, 1440],
          whatsappMinDelaySeconds: [12, 1, 300],
          whatsappMaxDelaySeconds: [30, 1, 600],
          whatsappAudienceDelaySeconds: [15, 1, 600],
          whatsappAudienceCooldownHours: [24, 0, 720],
          instagramIntervalMinutes: [20, 1, 1440],
          instagramMaxPerDay: [15, 1, 1500],
          instagramMinimumDiscount: [20, 0, 99],
          instagramDuplicateDays: [7, 1, 365],
          instagramAssetRetentionHours: [72, 24, 720],
          instagramFeedIntervalMinutes: [120, 5, 1440],
          instagramFeedMaxPerDay: [3, 1, 30],
          instagramFeedMinimumDiscount: [20, 0, 99],
          instagramFeedDuplicateDays: [7, 1, 365],
          instagramFeedCarouselSize: [4, 2, 10],
          instagramFeedCarouselsPerDay: [1, 1, 10],
          instagramFeedCarouselsPerWeek: [3, 1, 21]
        };
        for (const [key, [fallback, minimum, maximum]] of Object.entries(numericRules)) {
          data.config[key] = boundedNumber(data.config[key], fallback, minimum, maximum);
        }
        if (data.config.whatsappMaxDelaySeconds < data.config.whatsappMinDelaySeconds) {
          data.config.whatsappMaxDelaySeconds = data.config.whatsappMinDelaySeconds;
        }
        for (const [key, previousValue] of Object.entries(previousConfig)) {
          if (typeof previousValue !== 'boolean' || !Object.prototype.hasOwnProperty.call(body, key)) continue;
          data.config[key] = typeof body[key] === 'boolean' ? body[key] : previousValue;
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
        data.config.instagramUrl = normalizeInstagramProfileUrl(
          data.config.instagramUrl,
          previousConfig.instagramUrl || ''
        );
        for (const key of ['brandName', 'heroTitle', 'heroText', 'disclosure', 'contactEmail', 'seoSiteName', 'seoTitle', 'seoDescription', 'seoKeywords', 'seoImageUrl', 'affiliateDisclosureLabel', 'qualityBlockedTerms', 'monitoringEmail', 'legalResponsibleName', 'legalResponsibleType', 'legalCityState', 'legalPrivacyEmail', 'legalAffiliatePrograms', 'legalAboutCustomText', 'legalContactCustomText', 'legalTermsCustomText', 'legalPrivacyCustomText', 'searchConsoleSiteUrl', 'searchConsoleRedirectUri', 'whatsappDirectoryTitle', 'whatsappDirectoryIntro', 'whatsappDirectoryFooter']) {
          const maximum = key.endsWith('CustomText') ? 3000 : ['heroText', 'disclosure', 'seoDescription'].includes(key) ? 1000 : ['whatsappDirectoryIntro', 'whatsappDirectoryFooter'].includes(key) ? 500 : 300;
          data.config[key] = String(data.config[key] || '').trim().slice(0, maximum);
        }
        if (!/^https:\/\//i.test(data.config.searchConsoleRedirectUri)) data.config.searchConsoleRedirectUri = previousConfig.searchConsoleRedirectUri || '';
        if (!/^(?:sc-domain:|https?:\/\/)/i.test(data.config.searchConsoleSiteUrl)) data.config.searchConsoleSiteUrl = previousConfig.searchConsoleSiteUrl || '';

        if (Object.prototype.hasOwnProperty.call(body, 'instagramThemes')) {
          data.config.instagramThemes = sanitizeInstagramThemes(body.instagramThemes);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'instagramHighlights')) {
          data.config.instagramHighlights = sanitizeInstagramHighlights(body.instagramHighlights);
        }
        data.config.instagramStores = Array.isArray(data.config.instagramStores)
          ? [...new Set(data.config.instagramStores.map((entry) => String(entry).trim()).filter(Boolean))]
          : previousConfig.instagramStores || [];
        data.config.instagramAudienceCodes = Array.isArray(data.config.instagramAudienceCodes)
          ? [...new Set(data.config.instagramAudienceCodes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))]
          : previousConfig.instagramAudienceCodes || [];
        data.config.whatsappDirectoryIncludedCodes = sanitizeGroupDirectoryCodes(data.config.whatsappDirectoryIncludedCodes);
        data.config.whatsappDirectoryTargetCodes = sanitizeGroupDirectoryCodes(data.config.whatsappDirectoryTargetCodes);
        data.config.extensionStores = Array.isArray(data.config.extensionStores)
          ? [...new Set(data.config.extensionStores.map((entry) => String(entry).trim()).filter((entry) => ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'].includes(entry)))]
          : previousConfig.extensionStores || ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'];
        data.config.extensionAudienceCodes = Array.isArray(data.config.extensionAudienceCodes)
          ? [...new Set(data.config.extensionAudienceCodes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))]
          : previousConfig.extensionAudienceCodes || ['G01'];
        data.config.extensionEnabled = data.config.extensionEnabled !== false;
        data.config.extensionAutoApprove = data.config.extensionAutoApprove === true;
        if (!['automatic', 'manual'].includes(data.config.instagramThemeMode)) data.config.instagramThemeMode = 'automatic';
        if (!['single', 'carousel'].includes(String(data.config.instagramFeedPostType || ''))) data.config.instagramFeedPostType = previousConfig.instagramFeedPostType || 'single';
        if (!['square', 'portrait'].includes(String(data.config.instagramFeedFormat || ''))) data.config.instagramFeedFormat = previousConfig.instagramFeedFormat || 'portrait';
        if (!['rotating', 'classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'].includes(String(data.config.instagramFeedTemplateMode || ''))) data.config.instagramFeedTemplateMode = previousConfig.instagramFeedTemplateMode || 'rotating';
        if (!['daily', 'weekly'].includes(String(data.config.instagramFeedCarouselFrequency || ''))) data.config.instagramFeedCarouselFrequency = previousConfig.instagramFeedCarouselFrequency || 'daily';
        data.config.instagramFeedEnabled = data.config.instagramFeedEnabled === true;
        data.config.instagramFeedAutoFromWhatsapp = data.config.instagramFeedAutoFromWhatsapp === true;
        const previousFeedDays = Array.isArray(previousConfig.instagramFeedPublishingDays)
          ? previousConfig.instagramFeedPublishingDays
          : [1, 3, 5];
        const requestedFeedDays = Array.isArray(data.config.instagramFeedPublishingDays)
          ? [...new Set(data.config.instagramFeedPublishingDays.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
          : [];
        data.config.instagramFeedPublishingDays = requestedFeedDays.length ? requestedFeedDays : (previousFeedDays.length ? previousFeedDays : [1, 3, 5]);
        data.config.instagramFeedCaption = String(data.config.instagramFeedCaption || '').trim().slice(0, 2200);
        if (!/^v\d+\.\d+$/.test(String(data.config.instagramApiVersion || ''))) data.config.instagramApiVersion = previousConfig.instagramApiVersion || 'v25.0';
        for (const key of ['instagramRedirectUri', 'instagramCtaText', 'instagramDisclosureText']) {
          data.config[key] = String(data.config[key] || '').trim().slice(0, 300);
        }
        if (!/^https:\/\//i.test(data.config.instagramRedirectUri)) data.config.instagramRedirectUri = previousConfig.instagramRedirectUri || '';
        for (const key of ['instagramPublishingStart', 'instagramPublishingEnd', 'instagramFeedPublishingStart', 'instagramFeedPublishingEnd', 'publishingStart', 'publishingEnd', 'quietStart', 'quietEnd']) {
          if (!validClockTime(data.config[key])) data.config[key] = previousConfig[key];
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

        data.config.updatedAt = new Date().toISOString();

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
    if (req.body?.adminPassword && String(req.body.adminPassword).length < 12) {
      return res
        .status(400)
        .json({
          error:
            'A nova senha deve ter pelo menos 12 caracteres.'
        });
    }
    if (req.body?.adminPassword && String(req.body.adminPassword).length > 256) {
      return res.status(400).json({ error: 'A nova senha deve ter no máximo 256 caracteres.' });
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
            .SITE_URL ||
          process.env
            .PUBLIC_URL ||
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
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const offer = {
      id:
        createId(
          'offer'
        ),

      title: String(body.title || '').trim().slice(0, 300),
      store: String(body.store || 'Outra').trim().slice(0, 80),
      category: String(body.category || '').trim().slice(0, 100),
      image: String(body.image || '').trim().slice(0, 2000),
      affiliateUrl: String(body.affiliateUrl || '').trim().slice(0, 3000),
      freeShipping: body.freeShipping === true,
      featured: body.featured !== false,
      status: body.status === 'paused' ? 'paused' : 'active',

      price:
        Number(
          body.price
        ),

      originalPrice:
        Number(
          body
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

    const safeOfferLink = safeAffiliateDestination(offer.affiliateUrl);
    if (!offer.title || !(offer.price > 0) || !safeOfferLink) {
      return res
        .status(400)
        .json({
          error:
            'Produto, preço válido e link de uma loja autorizada são obrigatórios.'
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
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
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
          if (key in body) {
            candidate[key] = body[key];
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
        candidate.status = candidate.status === 'paused' ? 'paused' : 'active';

        if (!candidate.title || !(candidate.price > 0) || !safeAffiliateDestination(candidate.affiliateUrl)) {
          validationError = 'Produto, preço válido e link de uma loja autorizada são obrigatórios.';
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

        const history = data.queue.filter((item) => queueItemSourceMatches(item, offer));
        if (hasSentSourceInStore(data, offer)) {
          skippedHistory += 1;
          continue;
        }
        if (mode === 'missing' && history.length) {
          skippedHistory += 1;
          continue;
        }
        const queueItem = makeQueueItem(offer, data.config);
        if (mode === 'all' && hasPendingSource(data.queue, queueItem)) {
          skippedPending += 1;
          continue;
        }

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
    let alreadyQueued = false;
    let alreadySent = false;

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

        const nextItem = {
          ...makeQueueItem(
            offer,
            data.config
          ),

          force:
            Boolean(
              req.body.force
            )
        };

        if (hasSentSourceInStore(data, nextItem)) {
          alreadySent = true;
          return;
        }

        const existing = data.queue.find(
          (item) => ['pending', 'publishing'].includes(item.status) && queueItemSourceMatches(item, nextItem)
        );
        if (existing) {
          if (nextItem.force) existing.force = true;
          queueItem = existing;
          alreadyQueued = true;
          return;
        }

        queueItem = nextItem;
        data.queue.push(queueItem);
      }
    );

    if (alreadySent) {
      return res.status(409).json({ error: 'Esta oferta já foi publicada e não será repetida.' });
    }

    if (!queueItem) {
      return res
        .status(400)
        .json({
          error:
            'A oferta precisa ter um link afiliado confirmado antes do envio.'
        });
    }

    await addLog(
      `${alreadyQueued ? 'Oferta já estava na fila' : queueItem.force ? 'Publicação forçada' : 'Oferta enviada para a fila'}: ${queueItem.offerTitle}`,
      alreadyQueued || queueItem.force ? 'success' : 'info'
    );

    res
      .status(alreadyQueued ? 200 : 201)
      .json(
        { ...queueItem, alreadyQueued }
      );
  }
);

async function googleSearchConsoleAccessToken(secrets) {
  const now = Date.now();
  if (secrets.googleSearchConsoleAccessToken && Number(secrets.googleSearchConsoleTokenExpiresAt || 0) > now + 60_000) return secrets.googleSearchConsoleAccessToken;
  if (!secrets.googleSearchConsoleRefreshToken) throw new Error('Conecte sua conta Google primeiro.');
  const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: secrets.googleSearchConsoleClientId, client_secret: secrets.googleSearchConsoleClientSecret, refresh_token: secrets.googleSearchConsoleRefreshToken, grant_type: 'refresh_token' })
  }, 15_000);
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
  await updateSecrets({ googleSearchConsoleOAuthState: state, googleSearchConsoleOAuthStateExpiresAt: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({ client_id: secrets.googleSearchConsoleClientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/webmasters.readonly', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  res.json({ authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/api/search-console/callback', async (req, res) => {
  const [{ config }, secrets] = await Promise.all([readStore(), readSecrets()]);
  const adminUrl = `${String(config.canonicalUrl || '').replace(/\/+$/, '')}/admin`;
  if (!req.query.code || !req.query.state || req.query.state !== secrets.googleSearchConsoleOAuthState || Number(secrets.googleSearchConsoleOAuthStateExpiresAt || 0) < Date.now()) return res.redirect(`${adminUrl}?searchconsole=error`);
  try {
    const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: secrets.googleSearchConsoleClientId, client_secret: secrets.googleSearchConsoleClientSecret, code: String(req.query.code), redirect_uri: String(config.searchConsoleRedirectUri), grant_type: 'authorization_code' }) }, 15_000);
    const body = await response.json();
    if (!response.ok || !body.access_token) throw new Error(body.error_description || 'Falha ao autorizar.');
    await updateSecrets({ googleSearchConsoleAccessToken: body.access_token, googleSearchConsoleRefreshToken: body.refresh_token || secrets.googleSearchConsoleRefreshToken, googleSearchConsoleTokenExpiresAt: Date.now() + Number(body.expires_in || 3600) * 1000, googleSearchConsoleOAuthState: '', googleSearchConsoleOAuthStateExpiresAt: 0 });
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
      const response = await fetchWithTimeout(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }) }, 20_000);
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

function sanitizedBackupConfig(candidate, current) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 100_000) throw new Error('As configurações do backup excedem o limite seguro.');
  const restored = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!Object.hasOwn(current, key)) continue;
    const expected = current[key];
    if (typeof expected === 'number') {
      if (!Number.isFinite(Number(value))) continue;
      restored[key] = Math.max(-1_000_000, Math.min(1_000_000, Number(value)));
    } else if (typeof expected === 'boolean') {
      if (typeof value === 'boolean') restored[key] = value;
    } else if (typeof expected === 'string') {
      if (typeof value !== 'string' || value.length > 5_000) continue;
      const normalized = value.trim();
      if (/url$/i.test(key) && normalized && !/^https:\/\//i.test(normalized)) continue;
      restored[key] = normalized;
    } else if (Array.isArray(expected)) {
      if (Array.isArray(value) && value.length <= 250 && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 50_000) restored[key] = structuredClone(value);
    } else if (expected && typeof expected === 'object') {
      if (value && typeof value === 'object' && !Array.isArray(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 50_000) restored[key] = structuredClone(value);
    }
  }
  return restored;
}

app.post(
  '/api/admin/backup/restore',
  requireAdmin,
  async (req, res) => {
    const backup = req.body;
    if (!backup || backup.kind !== 'promoshop-safe-backup' || Number(backup.version) !== 1) {
      return res.status(400).json({ error: 'Arquivo de backup inválido ou incompatível.' });
    }

    const restoredCoupons = Array.isArray(backup.coupons)
      ? backup.coupons.slice(0, 300).map((coupon) => {
        if (!coupon || typeof coupon !== 'object' || Array.isArray(coupon)) return null;
        const parsed = parseCouponInput(coupon);
        if (parsed.error) return null;
        return {
          id: String(coupon.id || createId('coupon')).slice(0, 120),
          ...parsed.fields,
          shortCode: /^[a-z0-9_-]{4,80}$/i.test(String(coupon.shortCode || '')) ? String(coupon.shortCode).toLowerCase() : createCouponShortCode([]),
          source: ['manual', 'extension'].includes(coupon.source) ? coupon.source : 'manual',
          approvalStatus: coupon.approvalStatus === 'approved' ? 'approved' : 'pending',
          createdAt: String(coupon.createdAt || new Date().toISOString()).slice(0, 40),
          updatedAt: new Date().toISOString()
        };
      }).filter(Boolean)
      : null;

    await updateStore((data) => {
      if (backup.config && typeof backup.config === 'object' && !Array.isArray(backup.config)) {
        const restoredConfig = sanitizedBackupConfig(backup.config, data.config || {});
        data.config = { ...data.config, ...restoredConfig };
      }
      if (restoredCoupons) {
        const seenCodes = new Set();
        data.coupons = restoredCoupons.map((coupon) => {
          let shortCode = coupon.shortCode;
          while (seenCodes.has(shortCode)) shortCode = createCouponShortCode([...seenCodes].map((code) => ({ shortCode: code })));
          seenCodes.add(shortCode);
          return { ...coupon, shortCode, shortUrl: '' };
        });
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

app.post('/api/admin/extension/coupons/token', requireAdmin, async (_req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const current = await readSecrets();
  await updateSecrets({
    extensionCouponIngestToken: token,
    ...(current.extensionIngestToken && !current.extensionOfferIngestToken ? { extensionOfferIngestToken: current.extensionIngestToken } : {}),
    ...(current.extensionIngestToken ? { clearExtensionIngestToken: true } : {})
  });
  await addLog('Token exclusivo da extensão de cupons gerado.', 'success');
  res.json({ ok: true, token });
});

app.delete('/api/admin/extension/coupons/token', requireAdmin, async (_req, res) => {
  const current = await readSecrets();
  await updateSecrets({
    clearExtensionCouponIngestToken: true,
    ...(current.extensionIngestToken && !current.extensionOfferIngestToken ? { extensionOfferIngestToken: current.extensionIngestToken } : {}),
    ...(current.extensionIngestToken ? { clearExtensionIngestToken: true } : {})
  });
  await addLog('Token exclusivo da extensão de cupons revogado.', 'warning');
  res.json({ ok: true });
});

app.post('/api/admin/extension/mercadolivre/token', requireAdmin, async (_req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const current = await readSecrets();
  await updateSecrets({
    extensionOfferIngestToken: token,
    ...(current.extensionIngestToken && !current.extensionCouponIngestToken ? { extensionCouponIngestToken: current.extensionIngestToken } : {}),
    ...(current.extensionIngestToken ? { clearExtensionIngestToken: true } : {})
  });
  await addLog('Token exclusivo da extensão Mercado Livre gerado.', 'success');
  res.json({ ok: true, token });
});

app.delete('/api/admin/extension/mercadolivre/token', requireAdmin, async (_req, res) => {
  const current = await readSecrets();
  await updateSecrets({
    clearExtensionOfferIngestToken: true,
    ...(current.extensionIngestToken && !current.extensionCouponIngestToken ? { extensionCouponIngestToken: current.extensionIngestToken } : {}),
    ...(current.extensionIngestToken ? { clearExtensionIngestToken: true } : {})
  });
  await addLog('Token exclusivo da extensão Mercado Livre revogado.', 'warning');
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

app.post('/api/admin/instagram/highlights/preview', requireAdmin, async (req, res) => {
  try {
    const data = await readStore();
    const highlight = sanitizeInstagramHighlights([req.body?.highlight])[0];
    const variant = req.body?.variant === 'story' ? 'story' : 'cover';
    const asset = await generateInstagramHighlightAsset(highlight, data.config, String(req.body?.themeId || ''), variant);
    const canonical = String(data.config.canonicalUrl || '').replace(/\/$/, '');
    res.json({ ok: true, themeId: asset.themeId, variant, imageUrl: `${canonical}/media/instagram/${asset.fileName}`, fileName: asset.fileName });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/highlights/queue', requireAdmin, async (req, res) => {
  try {
    const highlight = sanitizeInstagramHighlights([req.body?.highlight])[0];
    const item = {
      id: createId('instagram-highlight'),
      kind: 'highlight',
      highlight,
      title: `Destaque: ${highlight.name}`,
      store: 'Destaques',
      themeId: String(req.body?.themeId || ''),
      status: 'pending',
      attempts: 0,
      force: false,
      createdAt: new Date().toISOString(),
      publishedAt: null,
      retryAt: null,
      error: null
    };
    await updateStore((data) => { data.instagramQueue ||= []; data.instagramQueue.push(item); });
    await addLog(`Instagram: Story de apresentação do Destaque ${highlight.name} adicionado à fila.`, 'success');
    res.status(201).json({ ok: true, item });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function feedSourceSnapshot(data, req, entry) {
  const kind = entry?.kind === 'coupon' ? 'coupon' : 'offer';
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  if (kind === 'coupon') {
    const coupon = (data.coupons || []).find((item) => String(item.id) === id && item.active !== false);
    return coupon ? {
      id: coupon.id, kind, title: coupon.title, store: coupon.store, image: coupon.image,
      discountType: coupon.discountType, discountValue: coupon.discountValue, shortUrl: couponShortUrl(coupon, req), link: coupon.link
    } : null;
  }
  const offer = (data.offers || []).find((item) => String(item.id) === id && item.status !== 'paused');
  return offer ? {
    id: offer.id, kind, title: offer.title, store: offer.store, price: offer.price, originalPrice: offer.originalPrice,
    discount: offer.discount, image: offer.image, affiliateUrl: offer.affiliateUrl, link: offer.affiliateUrl
  } : null;
}

app.post('/api/admin/instagram/feed/preview', requireAdmin, async (req, res) => {
  try {
    const data = await readStore();
    const requested = Array.isArray(req.body?.items) ? req.body.items : [{ kind: req.body?.kind, id: req.body?.id }];
    const sources = requested.map((entry) => feedSourceSnapshot(data, req, entry)).filter(Boolean).slice(0, 10);
    if (!sources.length) return res.status(404).json({ error: 'Selecione pelo menos uma oferta ou cupom ativo.' });
    const requestedTemplateMode = String(req.body?.templateMode || '');
    const templateMode = ['rotating', 'classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'].includes(requestedTemplateMode)
      ? requestedTemplateMode
      : (data.config.instagramFeedTemplateMode || 'rotating');
    const config = { ...data.config, instagramFeedFormat: req.body?.format === 'square' ? 'square' : 'portrait', instagramFeedTemplateMode: templateMode };
    const assets = [];
    for (const source of sources) assets.push(await generateInstagramFeedAsset(source, config, String(req.body?.themeId || ''), config.instagramFeedFormat));
    const canonical = String(data.config.canonicalUrl || '').replace(/\/$/, '');
    res.json({ ok: true, themeId: assets[0]?.themeId || '', templates: assets.map((asset) => asset.template), imageUrls: assets.map((asset) => `${canonical}/media/instagram/${asset.fileName}`), imageUrl: `${canonical}/media/instagram/${assets[0].fileName}`, fileNames: assets.map((asset) => asset.fileName) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/feed/queue', requireAdmin, async (req, res) => {
  try {
    const data = await readStore();
    const requested = Array.isArray(req.body?.items) ? req.body.items : [];
    const sources = requested.map((entry) => feedSourceSnapshot(data, req, entry)).filter(Boolean).slice(0, 10);
    const postType = req.body?.postType === 'carousel' ? 'carousel' : 'single';
    if (!sources.length) return res.status(400).json({ error: 'Selecione pelo menos uma oferta ou cupom ativo.' });
    if (postType === 'carousel' && sources.length < 2) return res.status(400).json({ error: 'Um carrossel precisa de pelo menos 2 itens.' });
    if (postType === 'single' && sources.length > 1) return res.status(400).json({ error: 'Selecione apenas um item para uma publicação única.' });
    const format = req.body?.format === 'square' ? 'square' : 'portrait';
    const requestedTemplateMode = String(req.body?.templateMode || '');
    const templateMode = ['rotating', 'classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'].includes(requestedTemplateMode)
      ? requestedTemplateMode
      : (['rotating', 'classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'].includes(String(data.config.instagramFeedTemplateMode || '')) ? data.config.instagramFeedTemplateMode : 'rotating');
    const item = {
      id: createId('instagram-feed'), postType, format, items: sources, sourceIds: sources.map((source) => source.id),
      title: postType === 'carousel' ? `Carrossel com ${sources.length} ofertas` : sources[0].title, store: postType === 'carousel' ? 'PromoShop' : sources[0].store,
      caption: String(req.body?.caption || data.config.instagramFeedCaption || '').trim().slice(0, 2200),
      origin: 'manual',
      templateMode,
      status: 'pending', attempts: 0, force: false, createdAt: new Date().toISOString(), scheduledFor: req.body?.scheduledFor ? new Date(req.body.scheduledFor).toISOString() : null,
      publishedAt: null, retryAt: null, error: null, mediaIds: [], assetFileNames: [], themeId: String(req.body?.themeId || '')
    };
    await updateStore((fresh) => { fresh.instagramFeedQueue ||= []; fresh.instagramFeedQueue.push(item); });
    await addLog(`Instagram Feed: ${postType === 'carousel' ? 'carrossel' : 'post'} criado na fila — ${item.title}.`, 'success');
    res.status(201).json({ ok: true, item });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/instagram/feed/queue/:id/publish', requireAdmin, async (req, res) => {
  const data = await readStore();
  const item = (data.instagramFeedQueue || []).find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Publicação do Feed não encontrada.' });
  if (item.status === 'sent') return res.status(409).json({ error: 'Esta publicação já foi enviada.' });
  if (item.status === 'failed') return res.status(409).json({ error: 'Use “Tentar novamente” antes de publicar este item.' });
  if (item.status !== 'pending') return res.status(409).json({ error: 'Esta publicação não está aguardando envio.' });
  const publishing = instagramPublishingState();
  if (publishing.meta || publishing.feed) return res.status(409).json({ error: 'O Instagram já está processando outra publicação. Aguarde a fila atualizar.' });
  processInstagramFeedQueue({ forceId: item.id }).catch((error) => console.error('Instagram Feed:', error.message));
  res.status(202).json({ ok: true, message: 'Publicação do Feed iniciada.' });
});

app.post('/api/admin/instagram/feed/queue/:id/retry', requireAdmin, async (req, res) => {
  let found = false;
  await updateStore((data) => {
    const item = (data.instagramFeedQueue || []).find((entry) => entry.id === req.params.id);
    if (!item || item.status === 'sent') return;
    found = true;
    Object.assign(item, { status: 'pending', attempts: 0, retryAt: null, error: null, instagramRateLimited: false, rateLimitedAt: null, metaPublishingStartedAt: null, permanentFailure: false });
  });
  if (!found) return res.status(404).json({ error: 'Publicação não encontrada ou já enviada.' });
  res.json({ ok: true });
});

app.delete('/api/admin/instagram/feed/queue/failed/all', requireAdmin, async (_req, res) => {
  let deleted = 0;
  await updateStore((data) => {
    const queue = data.instagramFeedQueue || [];
    deleted = queue.filter((item) => item.status === 'failed').length;
    data.instagramFeedQueue = queue.filter((item) => item.status !== 'failed');
    if (deleted > 0) appendStoreLog(data, `Instagram Feed: ${deleted} publicação(ões) com falha foram excluídas da fila.`, 'success');
  });
  res.json({ ok: true, deleted });
});

app.delete('/api/admin/instagram/feed/queue/:id', requireAdmin, async (req, res) => {
  let removed = false;
  await updateStore((data) => {
    const before = (data.instagramFeedQueue || []).length;
    data.instagramFeedQueue = (data.instagramFeedQueue || []).filter((entry) => entry.id !== req.params.id || entry.status === 'publishing');
    removed = data.instagramFeedQueue.length < before;
  });
  if (!removed) return res.status(400).json({ error: 'Não é possível excluir uma publicação em andamento.' });
  res.json({ ok: true });
});

app.post('/api/admin/instagram/queue/:id/publish', requireAdmin, async (req, res) => {
  const data = await readStore();
  const item = (data.instagramQueue || []).find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Publicação do Instagram não encontrada.' });
  if (item.status === 'sent') return res.status(409).json({ error: 'Este Story já foi publicado.' });
  if (item.status === 'failed') return res.status(409).json({ error: 'Use “Tentar novamente” antes de publicar este Story.' });
  if (item.status !== 'pending') return res.status(409).json({ error: 'Este Story não está aguardando publicação.' });
  const publishing = instagramPublishingState();
  if (publishing.meta || publishing.stories) return res.status(409).json({ error: 'O Instagram já está processando outra publicação. Aguarde a fila atualizar.' });
  processInstagramQueue({ forceId: item.id }).catch((error) => console.error('Instagram:', error.message));
  res.status(202).json({ ok: true, message: 'Publicação iniciada. O estado será atualizado no painel.' });
});

app.post('/api/admin/instagram/queue/retry-failed', requireAdmin, async (_req, res) => {
  let retried = 0;
  await updateStore((data) => {
    for (const item of data.instagramQueue || []) {
      if (item.status !== 'failed') continue;
      Object.assign(item, { status: 'pending', attempts: 0, retryAt: null, error: null, instagramRateLimited: false, rateLimitedAt: null, metaPublishingStartedAt: null });
      retried += 1;
    }
    if (retried > 0) appendStoreLog(data, `Instagram: ${retried} Story(s) com falha retornaram para a fila.`, 'success');
  });
  res.json({ ok: true, retried });
});

app.post('/api/admin/instagram/queue/:id/retry', requireAdmin, async (req, res) => {
  let found = false;
  await updateStore((data) => {
    const item = (data.instagramQueue || []).find((entry) => entry.id === req.params.id);
    if (!item || item.status === 'sent') return;
    found = true;
    Object.assign(item, { status: 'pending', attempts: 0, retryAt: null, error: null, instagramRateLimited: false, rateLimitedAt: null, metaPublishingStartedAt: null });
  });
  if (!found) return res.status(404).json({ error: 'Publicação não encontrada ou já enviada.' });
  res.json({ ok: true });
});

app.delete('/api/admin/instagram/queue/failed/all', requireAdmin, async (_req, res) => {
  let deleted = 0;
  await updateStore((data) => {
    const queue = data.instagramQueue || [];
    deleted = queue.filter((item) => item.status === 'failed').length;
    data.instagramQueue = queue.filter((item) => item.status !== 'failed');
    if (deleted > 0) appendStoreLog(data, `Instagram: ${deleted} Story(s) com falha foram excluídos da fila.`, 'success');
  });
  res.json({ ok: true, deleted });
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
  // A Meta precisa buscar a mídia fora da origem do site para criar o
  // container. Os demais recursos continuam protegidos por CORP same-origin.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Content-Disposition', 'inline');
  try {
    await fs.access(filePath);
    res.set('Cache-Control', 'public, max-age=259200, no-transform');
    res.type('image/jpeg');
    const stream = createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(404); res.end(); });
    stream.pipe(res);
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

  const parsedLink = safeAffiliateDestination(link);

  if (!title || !parsedLink) {
    return { error: 'Informe o título e um link HTTPS válido de uma loja permitida.' };
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
  return right.length >= 32 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extensionCouponFingerprint(coupon) {
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const store = normalize(coupon.store);
  const code = normalize(coupon.code);
  const link = String(coupon.link || '').trim().replace(/[?#].*$/, '').toLowerCase();
  return `${store}|${code || link}`;
}

function extensionOfferFingerprint(offer) {
  const externalId = String(offer.externalId || '').trim().toUpperCase();
  if (externalId) return `mercado livre|${externalId.replace('-', '')}`;
  try {
    const url = new URL(String(offer.productUrl || ''));
    const productId = `${url.pathname}${url.searchParams.get('wid') || ''}`.match(/MLB-?\d+/i)?.[0];
    if (productId) return `mercado livre|${productId.toUpperCase().replace('-', '')}`;
    return `mercado livre|${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '').toLowerCase()}`;
  } catch {
    return `mercado livre|${productFingerprint(offer)}`;
  }
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
  const couponToken = secrets.extensionCouponIngestToken || secrets.extensionIngestToken;
  if (!extensionTokenMatches(token, couponToken)) return res.status(401).json({ error: 'Token da extensão de cupons inválido.' });

  const now = Date.now();
  pruneRateMap(extensionRateLimit, now, 5000);
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
  const acceptedFingerprints = new Set();

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
        if (!allowDuplicate) { duplicates.push(parsed.fields.title); acceptedFingerprints.add(fingerprint); continue; }
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
        acceptedFingerprints.add(fingerprint);
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
      acceptedFingerprints.add(fingerprint);
    }
    storeData.coupons = storeData.coupons.slice(0, 300);
  });

  if (imported.length) await addLog(`Extensão: ${imported.length} cupom(ns) recebido(s)${config.extensionAutoApprove === true ? ' e aprovado(s)' : ' para revisão'}.`, 'success');
  res.status(imported.length || duplicates.length ? 202 : 400).json({
    ok: imported.length > 0,
    imported,
    duplicates,
    acceptedFingerprints: [...acceptedFingerprints],
    errors: errors.slice(0, 10)
  });
});

app.post('/api/extension/mercadolivre/offers', async (req, res) => {
  const body = extensionRequestBody(req);
  const secrets = await readSecrets();
  const token = String(body.token || req.headers['x-promoshop-extension-token'] || '').trim();
  const offerToken = secrets.extensionOfferIngestToken || secrets.extensionIngestToken;
  if (!extensionTokenMatches(token, offerToken)) return res.status(401).json({ error: 'Token da extensão Mercado Livre inválido.' });

  const now = Date.now();
  pruneRateMap(extensionRateLimit, now, 5000);
  const rateKey = `${req.ip || 'unknown'}:${token.slice(-8)}:offers`;
  const recent = extensionRateLimit.get(rateKey) || [];
  const activeRequests = recent.filter((timestamp) => now - timestamp < 60_000);
  if (activeRequests.length >= 20) return res.status(429).json({ error: 'Muitas importações em pouco tempo. Aguarde um minuto.' });
  activeRequests.push(now);
  extensionRateLimit.set(rateKey, activeRequests);

  const snapshot = await readStore();
  if (snapshot.config?.extensionEnabled === false) return res.status(403).json({ error: 'A extensão está desativada no painel.' });
  const incoming = Array.isArray(body.offers) ? body.offers : [body.offer || body];
  const imported = [];
  const duplicates = [];
  const errors = [];
  const acceptedFingerprints = new Set();

  await updateStore((data) => {
    data.offers ||= [];
    for (const raw of incoming.slice(0, 10)) {
      const title = String(raw?.title || '').trim().slice(0, 300);
      const price = Number(raw?.price || 0);
      const originalPrice = Number(raw?.originalPrice || 0);
      const discount = originalPrice > price && price > 0 ? Math.round((1 - price / originalPrice) * 100) : Number(raw?.discount || 0);
      const affiliateUrl = String(raw?.affiliateUrl || '').trim().slice(0, 3000);
      const productUrl = String(raw?.productUrl || '').trim().slice(0, 3000);
      const image = String(raw?.image || '').trim().slice(0, 2000);
      const externalId = String(raw?.externalId || '').trim().slice(0, 80);
      if (!title || !(price > 0)) { errors.push('Título e preço válido são obrigatórios.'); continue; }
      if (!(originalPrice > price) || discount < 1 || discount > 95) { errors.push(`${title}: a página não apresenta uma promoção válida.`); continue; }
      try {
        const imageUrl = new URL(image);
        const imageHost = imageUrl.hostname.toLowerCase();
        if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password || !(imageHost === 'mlstatic.com' || imageHost.endsWith('.mlstatic.com'))) throw new Error();
      } catch { errors.push(`${title}: imagem oficial válida não encontrada.`); continue; }
      try {
        const product = new URL(productUrl);
        const productHost = product.hostname.toLowerCase();
        if (product.protocol !== 'https:' || product.username || product.password || !(productHost === 'mercadolivre.com.br' || productHost.endsWith('.mercadolivre.com.br'))) throw new Error();
      } catch { errors.push(`${title}: página de produto inválida.`); continue; }
      try {
        const affiliate = new URL(affiliateUrl);
        if (affiliate.protocol !== 'https:' || affiliate.username || affiliate.password || affiliate.hostname.toLowerCase() !== 'meli.la') throw new Error();
      } catch { errors.push(`${title}: gere o link pela barra oficial de Afiliados.`); continue; }

      const candidate = {
        id: externalId ? `ml_${externalId.replace(/[^a-zA-Z0-9_-]/g, '')}` : createId('offer'),
        externalId,
        title,
        store: 'Mercado Livre',
        category: String(raw?.category || 'Mercado Livre').trim().slice(0, 100),
        price,
        originalPrice,
        discount,
        score: discount,
        image,
        productUrl,
        affiliateUrl,
        freeShipping: raw?.freeShipping === true,
        featured: discount >= 30,
        status: 'active',
        source: 'mercado-livre-extension'
      };
      const fingerprint = extensionOfferFingerprint(candidate);
      const existing = data.offers.find((offer) => extensionOfferFingerprint(offer) === fingerprint);
      const timestamp = new Date().toISOString();
      if (existing) {
        Object.assign(existing, candidate, {
          id: existing.id,
          createdAt: existing.createdAt || timestamp,
          updatedAt: timestamp,
          targetAudienceCodes: getAudienceCodesForOffer(candidate, data.config.whatsappAudiences)
        });
        duplicates.push(title);
        imported.push({ id: existing.id, title, updated: true });
      } else {
        candidate.createdAt = timestamp;
        candidate.updatedAt = timestamp;
        candidate.targetAudienceCodes = getAudienceCodesForOffer(candidate, data.config.whatsappAudiences);
        data.offers.unshift(candidate);
        imported.push({ id: candidate.id, title, updated: false });
      }
      acceptedFingerprints.add(fingerprint);
    }
  });

  if (imported.length) {
    const updated = imported.filter((item) => item.updated).length;
    await addLog(`Extensão Mercado Livre: ${imported.length - updated} oferta(s) importada(s) e ${updated} atualizada(s) com link de afiliado.`, 'success');
  }
  return res.status(imported.length ? 202 : 400).json({
    ok: imported.length > 0,
    imported,
    duplicates,
    acceptedFingerprints: [...acceptedFingerprints],
    errors: errors.slice(0, 10)
  });
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
      const fields = parsed.fields;
      coupon.title = fields.title;
      coupon.store = fields.store;
      coupon.code = fields.code;
      coupon.description = fields.description;
      coupon.discountType = fields.discountType;
      coupon.discountValue = fields.discountValue;
      coupon.minPurchase = fields.minPurchase;
      coupon.expiresAt = fields.expiresAt;
      coupon.link = fields.link;
      coupon.image = fields.image;
      coupon.featured = fields.featured;
      coupon.active = fields.active;
      coupon.targetAudienceCodes = fields.targetAudienceCodes;
      coupon.shortUrl = couponShortUrl(coupon, req);
      coupon.updatedAt = new Date().toISOString();
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
    let alreadyQueued = false;
    let alreadySent = false;
    await updateStore((data) => {
      const coupon = (data.coupons || []).find((entry) => entry.id === req.params.id);
      if (!coupon || coupon.active === false) return;
      const targetAudienceCodes = normalizeCouponAudienceCodes(coupon.targetAudienceCodes);
      if (!targetAudienceCodes.length) return;
      if (!coupon.shortCode) coupon.shortCode = createCouponShortCode(data.coupons);
      const couponForDelivery = { ...coupon, shortUrl: couponShortUrl(coupon, req) };
      const message = formatCouponMessage(couponForDelivery);
      const nextItem = {
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
      if (hasSentSourceInStore(data, nextItem)) {
        alreadySent = true;
        return;
      }
      const existing = data.queue.find(
        (item) => ['pending', 'publishing'].includes(item.status) && queueItemSourceMatches(item, nextItem)
      );
      if (existing) {
        if (nextItem.force) existing.force = true;
        queueItem = existing;
        alreadyQueued = true;
        return;
      }
      queueItem = nextItem;
      data.queue.push(queueItem);
    });
    if (alreadySent) return res.status(409).json({ error: 'Este cupom já foi publicado e não será repetido.' });
    if (!queueItem) return res.status(400).json({ error: 'Cupom não encontrado, inativo ou sem grupos selecionados.' });
    await addLog(`${alreadyQueued ? 'Cupom já estava na fila' : queueItem.force ? 'Cupom priorizado' : 'Cupom enviado para a fila'}: ${queueItem.offerTitle} → ${queueItem.targetAudienceCodes.join(', ')}`, alreadyQueued || queueItem.force ? 'success' : 'info');
    return res.status(alreadyQueued ? 200 : 201).json({ ...queueItem, alreadyQueued });
  }
);

app.post('/api/admin/group-directory/queue', requireAdmin, async (req, res) => {
  try {
    const data = await readStore();
    const audiences = Array.isArray(data.config.whatsappAudiences) ? data.config.whatsappAudiences : [];
    const activeCodes = new Set(audiences.filter((audience) => audience.enabled !== false).map((audience) => String(audience.code || '').toUpperCase()));
    const targetCodes = sanitizeGroupDirectoryCodes(req.body?.targetCodes).filter((code) => activeCodes.has(code));
    if (!targetCodes.length) return res.status(400).json({ error: 'Selecione pelo menos um grupo que receberá a divulgação.' });
    const directory = buildGroupDirectoryMessage({
      title: req.body?.title,
      intro: req.body?.intro,
      footer: req.body?.footer,
      includedCodes: req.body?.includedCodes
    }, audiences);
    const force = req.body?.force === true;
    const destinations = force ? [targetCodes] : targetCodes.map((code) => [code]);
    const items = destinations.map((codes) => ({
      id: createId('queue'),
      kind: 'group-directory',
      offerId: null,
      offerTitle: String(req.body?.title || 'Divulgação dos grupos').trim().slice(0, 120) || 'Divulgação dos grupos',
      store: 'PromoShop',
      targetAudienceCodes: codes,
      includedAudienceCodes: directory.groups.map((group) => group.code),
      skipCommunityDestination: true,
      message: directory.message,
      messageSource: 'group-directory',
      aiStatus: 'not-applicable',
      image: '',
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
      sentAt: null,
      error: null,
      force
    }));
    await updateStore((fresh) => { fresh.queue.push(...items); });
    await addLog(`Divulgação dos grupos ${force ? 'priorizada' : 'adicionada à fila'}: links ${directory.groups.map((group) => group.code).join(', ')} → destinos ${targetCodes.join(', ')}.`, force ? 'success' : 'info');
    return res.status(201).json({ ok: true, count: items.length, targetCodes, includedCodes: directory.groups.map((group) => group.code) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post(
  '/api/admin/collect',
  requireAdmin,
  async (
    req,
    res
  ) => {
    const pauseRound = req.body?.pauseRound === true;
    return res.json(
      await runCollectionWhenIdle({
        requestedByAdmin: true,
        allowOutsidePublishingWindow: true,
        ignorePublicationRound: pauseRound
      })
    );
  }
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
    let duplicateBlocked = false;

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
          if (hasSentSourceInStore(data, item) || hasBlockingPendingSource(data.queue, item)) {
            item.status = 'skipped';
            item.force = false;
            item.publishingAt = null;
            item.error = 'Oferta repetida bloqueada: esta fonte já foi publicada ou já está representada na fila.';
            item.skippedAt = new Date().toISOString();
            duplicateBlocked = true;
            return;
          }
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

    if (duplicateBlocked) {
      return res.status(409).json({ error: 'Esta oferta já está protegida contra repetição.' });
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
    let duplicateBlocked = false;

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
          const sourceAlreadySent = hasSentSourceInStore(data, item);
          if (sourceAlreadySent) {
            item.status = 'skipped';
            item.force = false;
            item.publishingAt = null;
            item.error = 'Oferta repetida bloqueada: esta fonte já foi publicada anteriormente.';
            item.skippedAt = new Date().toISOString();
            duplicateBlocked = true;
            return;
          }

          item.status =
            'pending';

          item.force =
            true;

          item.error =
            null;

          item.failedAt =
            null;

          // Claims anteriores podem ser liberados. Destinos efetivamente
          // tentados ou concluídos permanecem registrados e serão excluídos
          // do novo envio, permitindo retomar somente o que ficou faltando.
          item.deliveryClaimedDestinationIds = [];

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

    if (duplicateBlocked) {
      return res.status(409).json({ error: 'Esta oferta já está protegida contra repetição.' });
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
    const stopped = await stopWhatsappWorkerProcess();

    updateWhatsappRuntime({
      status: 'offline',
      qrDataUrl: null,
      pairingCode: null,
      message: 'Publicador parado pelo painel.'
    });

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
      ok: stopped.exited,
      forced: stopped.forced
    });
  }
);

app.post(
  '/api/admin/whatsapp/reconnect',
  requireAdmin,
  async (_req, res) => {
    const alreadyRunning = Boolean(whatsappReconnectPromise);
    if (!alreadyRunning) {
      void reconnectWhatsappWorker().catch(reportWhatsappReconnectFailure);
    }
    return res.json({
      ok: true,
      connected: false,
      reconnecting: true,
      processRunning: Boolean(whatsappProcess) || !alreadyRunning,
      status: 'starting',
      message: alreadyRunning
        ? 'A reconexão já está em andamento. Aguarde alguns segundos para o painel atualizar.'
        : 'Reconexão iniciada. A sessão salva será restaurada; se necessário, um novo QR Code aparecerá.'
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

    const whatsapp = effectiveWhatsappState(data);

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

// Atualização pequena para a tela do WhatsApp. O painel consultava o
// dashboard inteiro a cada poucos segundos apenas para acompanhar conexão,
// QR Code e grupos, transferindo também ofertas, filas, cupons e logs.
app.get('/api/admin/whatsapp/state', requireAdmin, async (_req, res) => {
  const data = await readStore();
  res.set('Cache-Control', 'no-store');
  res.json({
    whatsapp: effectiveWhatsappState(data),
    pendingQueueCount: (Array.isArray(data.queue) ? data.queue : [])
      .filter((item) => item?.status === 'pending')
      .length
  });
});

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

    let store = await readStore();
    // A coleta pode ter iniciado enquanto esta requisição aguardava o banco.
    // Reconfira o bloqueio antes de recuperar ou reivindicar qualquer item.
    if (collectionInProgress) {
      return res
        .status(204)
        .end();
    }
    let sentSourceIndex = createQueueSourceIndex(store.queue, (item) => item?.status === 'sent');
    const repeatedPendingIds = store.queue
      .filter((item) => (
        item?.status === 'pending' &&
        item?.kind !== 'group-directory' &&
        hasSentSourceInStore(store, item, sentSourceIndex)
      ))
      .map((item) => item.id);
    if (repeatedPendingIds.length) {
      const repeatedPendingIdSet = new Set(repeatedPendingIds);
      await updateStore((data) => {
        for (const item of data.queue) {
          if (!repeatedPendingIdSet.has(item.id) || item.status !== 'pending') continue;
          item.status = 'skipped';
          item.force = false;
          item.publishingAt = null;
          item.error = 'Oferta repetida bloqueada: esta fonte já foi publicada anteriormente.';
          item.skippedAt = new Date().toISOString();
        }
      });
      store = await readStore();
      sentSourceIndex = createQueueSourceIndex(store.queue, (item) => item?.status === 'sent');
      await addLog(`${repeatedPendingIds.length} duplicata(s) pendente(s) bloqueada(s) para não repetir ofertas.`, 'info');
    }
    const stalePublishingCutoff = Date.now() - 15 * 60 * 1000;
    let recoveredPublishing = 0;
    let uncertainPublishing = 0;
    const hasStalePublishing = store.queue.some((item) => (
      item.status === 'publishing' &&
      Number.isFinite(new Date(item.publishingAt || item.createdAt || 0).getTime()) &&
      new Date(item.publishingAt || item.createdAt || 0).getTime() < stalePublishingCutoff
    ));
    if (hasStalePublishing) {
      await updateStore((data) => {
        for (const item of data.queue) {
          const publishedAt = new Date(item.publishingAt || item.createdAt || 0).getTime();
          if (item.status !== 'publishing' || !Number.isFinite(publishedAt) || publishedAt >= stalePublishingCutoff) continue;
          const deliveryStarted = Array.isArray(item.deliveryAttemptedDestinationIds) && item.deliveryAttemptedDestinationIds.length > 0;
          item.status = deliveryStarted ? 'failed' : 'pending';
          item.publishingAt = null;
          if (!deliveryStarted) item.deliveryClaimedDestinationIds = [];
          item.error = deliveryStarted
            ? 'O envio foi interrompido depois de começar. Para não repetir a oferta, ela não será reenviada automaticamente.'
            : 'Publicação retomada após uma interrupção do publicador.';
          if (deliveryStarted) {
            item.failedAt = new Date().toISOString();
            uncertainPublishing += 1;
          }
          recoveredPublishing += 1;
        }
      });
      store = await readStore();
      const recoveredMessage = uncertainPublishing
        ? `${uncertainPublishing} publicação(ões) interrompida(s) foram marcadas para revisão e não serão repetidas automaticamente${recoveredPublishing > uncertainPublishing ? `; ${recoveredPublishing - uncertainPublishing} outra(s) foi(ram) retomada(s).` : '.'}`
        : `${recoveredPublishing} publicação(ões) retomada(s) após uma interrupção do publicador.`;
      await addLog(recoveredMessage, 'info');
    }

    const {
      config,
      queue,
      offers
    } = store;

    const now =
      new Date();

    const pendingSourceIndex = createQueueSourceIndex(queue, (item) => ['pending', 'publishing'].includes(item?.status));

    const forced =
      queue.find(
        (item) =>
          item.status ===
            'pending' &&
          item.force &&
          !hasSentSourceInStore(store, item, sentSourceIndex) &&
          !hasBlockingPendingSource(queue, item, pendingSourceIndex)
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
    async function claimQueueItem(item, fields = {}) {
      let claimed = false;
      await updateStore((data) => {
        const saved = data.queue.find((entry) => entry.id === item?.id && entry.status === 'pending');
        if (!saved) return;
        Object.assign(saved, fields);
        saved.status = 'publishing';
        saved.publishingAt = new Date().toISOString();
        saved.error = null;
        claimed = true;
      });
      return claimed;
    }

    async function prepareWithAi(
      item,
      roundAudienceCode = ''
    ) {
      if (!item) {
        return null;
      }

      try {
        if (item.kind === 'group-directory') {
          const selectedCodes = sanitizeGroupDirectoryCodes(item.targetAudienceCodes);
          const normalizedRoundAudienceCode = normalizeAudienceCode(roundAudienceCode);
          if (normalizedRoundAudienceCode && !selectedCodes.includes(normalizedRoundAudienceCode)) {
            return { skippedForAudience: true };
          }
          const deliveryAudienceCodes = normalizedRoundAudienceCode ? [normalizedRoundAudienceCode] : selectedCodes;
          const message = String(item.message || '').trim().slice(0, 4000);
          if (!deliveryAudienceCodes.length || !message) throw new Error('Divulgação sem mensagem ou grupo de destino.');
          await updateStore((data) => {
            const saved = data.queue.find((entry) => entry.id === item.id && entry.status === 'pending');
            if (!saved) return;
            saved.message = message;
            saved.messageSource = 'group-directory';
            saved.aiStatus = 'not-applicable';
            saved.targetAudienceCodes = [...deliveryAudienceCodes];
            saved.roundAudienceCode = normalizedRoundAudienceCode || null;
            delete saved.aiRetryAt;
            delete saved.aiError;
          });
          return { ...item, message, messageSource: 'group-directory', aiStatus: 'not-applicable', targetAudienceCodes: deliveryAudienceCodes, roundAudienceCode: normalizedRoundAudienceCode || null };
        }

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

        const normalizedRoundAudienceCode =
          normalizeAudienceCode(
            roundAudienceCode
          );

        if (
          !normalizedRoundAudienceCode &&
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
        const claimed = await claimQueueItem(forced, {
          targetAudienceCodes: prepared.targetAudienceCodes,
          roundAudienceCode: prepared.roundAudienceCode || null,
          message: prepared.message,
          messageSource: prepared.messageSource,
          aiStatus: prepared.aiStatus,
          aiGenerationVersion: prepared.aiGenerationVersion
        });
        if (claimed) return res.json({ ...prepared, status: 'publishing' });
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
        const claimed = await claimQueueItem(forced, {
          targetAudienceCodes: prepared.targetAudienceCodes,
          roundAudienceCode: prepared.roundAudienceCode || null,
          message: prepared.message,
          messageSource: prepared.messageSource,
          aiStatus: prepared.aiStatus,
          aiGenerationVersion: prepared.aiGenerationVersion
        });
        if (claimed) return res.json({ ...prepared, status: 'publishing' });
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

    const today = analyticsDay(now);

    const sentToday =
      queue.filter(
        (item) =>
          item.status ===
            'sent' &&
          item.sentAt && analyticsDay(new Date(item.sentAt)) === today
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
     * ======================================================
     * INTERVALO CONFIGURADO NO PAINEL
     * ======================================================
     *
     * O intervalo separa rodadas completas. Dentro da mesma rodada, G01, G02,
     * G03 e os demais públicos seguem em sequência com a pausa curta e segura
     * aplicada pelo worker do WhatsApp.
     *
     * Publicações marcadas como "Publicar agora" são tratadas antes deste
     * bloco e continuam imediatas.
     */
    const publicationInterval =
      getWhatsappRoundIntervalState(
        queue,
        config.whatsappIntervalMinutes,
        round,
        now.getTime()
      );

    if (!publicationInterval.elapsed) {
      return res
        .status(204)
        .end();
    }

    const sentLastHour = queue.filter((item) => (
      item.status === 'sent' &&
      Number.isFinite(new Date(item.sentAt || 0).getTime()) &&
      now.getTime() - new Date(item.sentAt).getTime() < 60 * 60 * 1000
    )).length;
    if (sentLastHour >= Number(config.whatsappMaxPerHour || 100)) {
      return res.status(204).end();
    }

    /*
     * Se NÃO existe rodada,
     * significa que estamos prestes
     * a começar uma nova.
     *
     * O intervalo já foi validado acima para a abertura desta nova rodada.
     * Rodadas em andamento continuam até atender ou ignorar todos os grupos.
     */
    if (!round) {
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

      let historySkipped = 0;
      let duplicatePendingSkipped = 0;
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

            if (hasSentSourceInStore(store, item, sentSourceIndex)) {
              historySkipped += 1;
              return false;
            }

            if (hasBlockingPendingSource(queue, item, pendingSourceIndex)) {
              duplicatePendingSkipped += 1;
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

      const prioritizedCandidates = prioritizeWhatsappCandidates(
        candidates,
        offers,
        round.storePriorityCursor
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
          `Rodada ${round.id}: nenhum produto disponível para ${audienceCode}${historySkipped ? `; ${historySkipped} oferta(s) já publicada(s) foram bloqueadas para não repetir.` : ''}${duplicatePendingSkipped ? `; ${duplicatePendingSkipped} duplicata(s) pendente(s) foram ignoradas.` : ''} Grupo ignorado nesta rodada.`,
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
     * A próxima esperará o intervalo configurado.
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
        of prioritizedCandidates
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
          const nextStorePriority = nextWhatsappStorePriorityCursor(
            item,
            offers,
            round.storePriorityCursor
          );

          /*
           * Registra oficialmente que
           * este item pertence à rodada.
           */
          let productClaimed = false;
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

              saved.status = 'publishing';
              saved.publishingAt = new Date().toISOString();
              saved.error = null;
              productClaimed = true;

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

              saved.storePriorityNextCursor = nextStorePriority;
            }
          );

          if (productClaimed) {
            await addLog(
              `Rodada ${round.id}: ${item.offerTitle} selecionado para ${audienceCode}. Próxima prioridade: ${WHATSAPP_STORE_PRIORITY[nextStorePriority]}.`,
              'success'
            );

            productPrepared = true;

            return res.json({
              ...prepared,

              status: 'publishing',

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
        ).slice(0, 160),

      mentionAllEnabled:
        config.whatsappMentionAllEnabled === true
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

    updateWhatsappRuntime({ groups });

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

    updateWhatsappRuntime({
      status: 'qr',
      qrDataUrl,
      pairingCode: null,
      message: 'Leia o QR Code com o WhatsApp.'
    });

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

          // O QR é uma credencial temporária e permanece somente no estado
          // de execução; nunca deve ser gravado no banco.
          qrDataUrl: null,

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

    updateWhatsappRuntime({
      status: 'pairing',
      qrDataUrl: null,
      pairingCode,
      message: 'Digite este código no WhatsApp do celular.'
    });

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

          // O código de pareamento é exibido pelo estado em memória e não é
          // persistido no PostgreSQL.
          pairingCode: null,

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

    const now = new Date();
    const message = String(req.body.message || '').slice(0, 200);
    const previousRuntime = whatsappRuntimeState;
    const stateChanged = !previousRuntime || previousRuntime.status !== status || previousRuntime.message !== message;
    const shouldPersist = stateChanged || now.getTime() - whatsappHeartbeatPersistedAt >= WHATSAPP_HEARTBEAT_PERSIST_MS;

    updateWhatsappRuntime({
      status,
      message,
      ...(['authenticated', 'connected'].includes(status) ? { qrDataUrl: null, pairingCode: null } : {})
    }, now);

    if (shouldPersist) {
      await updateStore(
        (data) => {
          data.meta = data.meta || {};
          data.meta.whatsapp = {
            ...data.meta.whatsapp,
            status,
            lastSeenAt: now.toISOString(),
            qrDataUrl: ['authenticated', 'connected'].includes(status)
              ? null
              : data.meta.whatsapp?.qrDataUrl,
            pairingCode: status === 'connected'
              ? null
              : data.meta.whatsapp?.pairingCode,
            message
          };
        }
      );
      whatsappHeartbeatPersistedAt = now.getTime();
    }

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
  '/api/worker/queue/:id/destination/claim',
  requireWorker,
  async (req, res) => {
    const destinationId = String(req.body?.destinationId || '').trim().slice(0, 160);
    const destinationName = String(req.body?.destinationName || '').trim().slice(0, 200);
    if (!destinationId) return res.status(400).json({ error: 'Destino ausente.' });

    let claimed = false;
    let alreadyClaimed = false;
    let itemStatus = '';
    await updateStore((data) => {
      const item = data.queue.find((entry) => entry.id === req.params.id);
      if (!item) return;

      itemStatus = item.status;
      item.deliveryClaimedDestinationIds = Array.isArray(item.deliveryClaimedDestinationIds)
        ? [...new Set(item.deliveryClaimedDestinationIds.map((id) => String(id)))]
        : [];
      item.deliveryAttemptedDestinationIds = Array.isArray(item.deliveryAttemptedDestinationIds)
        ? [...new Set(item.deliveryAttemptedDestinationIds.map((id) => String(id)))]
        : [];
      item.deliverySentDestinationIds = Array.isArray(item.deliverySentDestinationIds)
        ? [...new Set(item.deliverySentDestinationIds.map((id) => String(id)))]
        : [];

      if (
        item.deliveryClaimedDestinationIds.includes(destinationId) ||
        item.deliveryAttemptedDestinationIds.includes(destinationId) ||
        item.deliverySentDestinationIds.includes(destinationId)
      ) {
        alreadyClaimed = true;
        return;
      }
      if (!['pending', 'publishing'].includes(item.status)) return;

      item.deliveryClaimedDestinationIds.push(destinationId);
      item.deliveryAttemptedDestinationNames = {
        ...(item.deliveryAttemptedDestinationNames || {}),
        [destinationId]: destinationName || item.deliveryAttemptedDestinationNames?.[destinationId] || ''
      };
      claimed = true;
    });

    if (!itemStatus) return res.status(404).json({ error: 'Publicação não encontrada.' });
    return res.json({ ok: true, claimed, alreadyClaimed, status: itemStatus });
  }
);

app.post('/api/worker/queue/:id/destination/started', requireWorker, async (req, res) => {
  const destinationId = String(req.body?.destinationId || '').trim().slice(0, 160);
  if (!destinationId) return res.status(400).json({ error: 'Destino ausente.' });
  let found = false;
  await updateStore((data) => {
    const item = data.queue.find((entry) => entry.id === req.params.id);
    if (!item) return;
    found = true;
    item.deliveryClaimedDestinationIds = (item.deliveryClaimedDestinationIds || []).filter((id) => String(id) !== destinationId);
    item.deliveryAttemptedDestinationIds = [...new Set([...(item.deliveryAttemptedDestinationIds || []).map(String), destinationId])];
    item.deliveryStartedAt ||= new Date().toISOString();
  });
  if (!found) return res.status(404).json({ error: 'Publicação não encontrada.' });
  return res.json({ ok: true });
});

app.post('/api/worker/queue/:id/destination/release', requireWorker, async (req, res) => {
  const destinationId = String(req.body?.destinationId || '').trim().slice(0, 160);
  if (!destinationId) return res.status(400).json({ error: 'Destino ausente.' });
  await updateStore((data) => {
    const item = data.queue.find((entry) => entry.id === req.params.id);
    if (!item) return;
    const attempted = (item.deliveryAttemptedDestinationIds || []).map(String).includes(destinationId);
    const sent = (item.deliverySentDestinationIds || []).map(String).includes(destinationId);
    if (!attempted && !sent) {
      item.deliveryClaimedDestinationIds = (item.deliveryClaimedDestinationIds || []).filter((id) => String(id) !== destinationId);
    }
  });
  return res.json({ ok: true });
});

app.post(
  '/api/worker/queue/:id/destination/complete',
  requireWorker,
  async (req, res) => {
    const destinationId = String(req.body?.destinationId || '').trim().slice(0, 160);
    const destinationName = String(req.body?.destinationName || '').trim().slice(0, 200);
    if (!destinationId) return res.status(400).json({ error: 'Destino ausente.' });

    let itemFound = false;
    await updateStore((data) => {
      const item = data.queue.find((entry) => entry.id === req.params.id);
      if (!item) return;
      itemFound = true;
      item.deliveryClaimedDestinationIds = (item.deliveryClaimedDestinationIds || []).filter((id) => String(id) !== destinationId);
      item.deliverySentDestinationIds = Array.isArray(item.deliverySentDestinationIds)
        ? [...new Set(item.deliverySentDestinationIds.map((id) => String(id)))]
        : [];
      if (!item.deliverySentDestinationIds.includes(destinationId)) item.deliverySentDestinationIds.push(destinationId);
      item.deliveryCompletedDestinationNames = {
        ...(item.deliveryCompletedDestinationNames || {}),
        [destinationId]: destinationName || item.deliveryCompletedDestinationNames?.[destinationId] || ''
      };
    });

    if (!itemFound) return res.status(404).json({ error: 'Publicação não encontrada.' });
    return res.json({ ok: true });
  }
);

app.post(
  '/api/worker/queue/:id/complete',
  requireWorker,
  async (
    req,
    res
  ) => {
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

        // A confirmação é idempotente. Se o worker repetir a chamada depois
        // de uma resposta de rede perdida, nunca recriamos a publicação.
        if (item.status === 'sent') {
          return;
        }

        item.status =
          'sent';

        item.sentAt =
          new Date()
            .toISOString();

        item.publishingAt = null;

        item.error =
          null;

        recordSentSourceInLedger(data, item);

        appendStoreLog(
          data,
          item.roundAudienceCode
            ? `WhatsApp: ${item.offerTitle} enviado para ${item.roundAudienceCode}.`
            : `WhatsApp: publicação enviada (${req.params.id}).`,
          'success'
        );

        /*
         * ==================================================
         * ATUALIZA A RODADA
         * ==================================================
         */

        const round =
          data.meta
            ?.publicationRound;

        let deferredUntilRoundCompletion = false;

        if (
          round &&
          item.roundId &&
          round.id ===
            item.roundId &&
          item.roundAudienceCode
          ) {
          deferredUntilRoundCompletion = true;
          const audienceCode =
            normalizeAudienceCode(
              item
                .roundAudienceCode
            );

          round.storePriorityCursor = normalizeWhatsappStorePriorityCursor(
            item.storePriorityNextCursor ?? round.storePriorityCursor
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

            releaseInstagramAfterWhatsappRound(data, round);

            data.meta
              .lastPublicationRound = {
              ...round
            };

            data.meta
              .publicationRound =
              null;
          }
        }

        // Publicações manuais ou antigas que não pertencem à rodada ativa
        // continuam sendo liberadas imediatamente, preservando o fluxo já
        // existente. Somente a rodada automática aguarda todos os grupos.
        if (!deferredUntilRoundCompletion) {
          const instagramQueuedItem = enqueueInstagramFromWhatsapp(data, item);
          const instagramFeedQueuedItem = enqueueInstagramFeedFromWhatsapp(data, item);
          item.instagramReleaseProcessedAt = new Date().toISOString();

          if (instagramQueuedItem) {
            appendStoreLog(
              data,
              `Instagram: ${instagramQueuedItem.title} entrou na fila de Stories após o envio no WhatsApp.`,
              'success'
            );
          }

          if (instagramFeedQueuedItem) {
            appendStoreLog(
              data,
              `Instagram: ${instagramFeedQueuedItem.title} entrou na fila do Feed após o envio no WhatsApp.`,
              'success'
            );
          }
        }
      }
    );

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
    let alreadySent = false;

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

        // O envio pode ter sido aceito pelo WhatsApp mesmo que a resposta da
        // confirmação tenha falhado. Nunca devolva uma publicação confirmada
        // para pending, pois isso causa uma segunda mensagem.
        if (item.status === 'sent') {
          alreadySent = true;
          failedItem = {
            title: item.offerTitle,
            status: item.status,
            attempts: item.attempts
          };
          return;
        }

        item.attempts =
          Number(
            item.attempts ||
            0
          ) + 1;

        const attemptedIds = new Set(
          (Array.isArray(item.deliveryAttemptedDestinationIds) ? item.deliveryAttemptedDestinationIds : [])
            .map((id) => String(id))
        );
        const sentIds = new Set(
          (Array.isArray(item.deliverySentDestinationIds) ? item.deliverySentDestinationIds : [])
            .map((id) => String(id))
        );
        const hasUnconfirmedDelivery = [...attemptedIds].some((id) => !sentIds.has(id));
        const retrySafe = req.body?.retrySafe === true;
        item.deliveryClaimedDestinationIds = [];
        item.status =
          (!retrySafe && hasUnconfirmedDelivery) || item.attempts >= 3
            ? 'failed'
            : 'pending';

        item.publishingAt = null;

        item.error =
          String(
            req.body.error ||
            'Falha desconhecida'
          ).slice(
            0,
            500
          );
        if (hasUnconfirmedDelivery && !retrySafe) {
          item.error = 'O envio foi iniciado, mas não foi confirmado. Para não repetir a oferta, ela exige revisão manual antes de qualquer nova tentativa.';
          item.failedAt = new Date().toISOString();
        } else if (retrySafe && item.status === 'pending') {
          item.error = 'Alguns destinos foram concluídos. O sistema tentará novamente somente os destinos que ainda não foram iniciados.';
        }

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

              releaseInstagramAfterWhatsappRound(data, round);

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

    if (!alreadySent) {
      await addLog(
        `WhatsApp: falha ao publicar${failedItem?.title ? ` ${failedItem.title}` : ''} (${String(req.body.error || 'erro')}).`,
        'error'
      );
    }

    res.json({
      ok: true,
      alreadySent
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
          coupons: [],
          audiences: []
        });
      }

      const data = await readStore();
      const history = sanitizeAssistantHistory(req.body?.history);
      const userContext = [...history.filter((entry) => entry.role === 'user').map((entry) => entry.content), message].join(' ');
      const eligibleOffers = (Array.isArray(data.offers) ? data.offers : [])
        .filter((offer) => publicOfferAllowed(offer, data.config));
      const eligibleCoupons = (Array.isArray(data.coupons) ? data.coupons : [])
        .filter((coupon) => publicCouponAllowed(coupon));
      const audiences = Array.isArray(data.config.whatsappAudiences)
        ? data.config.whatsappAudiences
        : [];
      const wantsCoupon = assistantCouponIntent(userContext);
      const query = assistantCatalogQuery(userContext, wantsCoupon ? [...eligibleOffers, ...eligibleCoupons] : eligibleOffers);
      const currentBudget = assistantBudgetFromText(message);
      const budget = currentBudget.specified ? currentBudget : assistantBudgetFromText(userContext);
      const requestedStore = assistantStoreFromText(userContext);
      const seenProductIds = new Set((Array.isArray(req.body?.seenProductIds) ? req.body.seenProductIds : [])
        .map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100));
      const interestAudiences = assistantAudienceRecommendations(userContext, [], audiences);

      if (wantsCoupon) {
        const coupons = assistantCoupons(query, eligibleCoupons, { store: requestedStore, seenCouponIds: new Set((Array.isArray(req.body?.seenCouponIds) ? req.body.seenCouponIds : []).map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100)) });
        if (!coupons.length) {
          return res.json({
            status: 'question',
            message: `Não encontrei um cupom ativo${query ? ` para ${query}` : ''}${requestedStore ? ` na ${requestedStore}` : ''} agora. Quer tentar outra loja ou produto?`,
            products: [],
            coupons: [],
            audiences: interestAudiences
          });
        }
        const couponPayload = coupons.map((coupon) => ({
          id: String(coupon.id || ''),
          title: String(coupon.title || 'Cupom disponível'),
          store: String(coupon.store || ''),
          description: String(coupon.description || ''),
          code: String(coupon.code || ''),
          discountType: String(coupon.discountType || ''),
          discountValue: Number(coupon.discountValue || 0),
          minPurchase: Number(coupon.minPurchase || 0),
          expiresAt: coupon.expiresAt || '',
          shortUrl: couponShortUrl(coupon, req)
        }));
        return res.json({
          status: 'result',
          message: `Encontrei ${couponPayload.length} ${couponPayload.length === 1 ? 'cupom' : 'cupons'} que podem ajudar. Confira as regras antes de ativar.`,
          products: [],
          coupons: couponPayload,
          audiences: interestAudiences
        });
      }

      if (!query) {
        if (interestAudiences.length) {
          return res.json({
            status: 'result',
            message: 'Encontrei os grupos que mais combinam com o que você gosta. Se quiser, também posso procurar um produto específico e perguntar sua faixa de preço.',
            products: [],
            coupons: [],
            audiences: interestAudiences
          });
        }
        return res.json({
          status: 'question',
          message: 'Claro! Qual produto você está procurando? Se puder, conte também para que vai usar e quanto pretende gastar.',
          products: [],
          coupons: [],
          audiences: []
        });
      }

      if (!budget.specified) {
        return res.json({
          status: 'question',
          message: `Entendi: você procura ${query}. Qual é o valor máximo que pretende gastar? Você também pode responder “sem limite”.`,
          products: [],
          coupons: [],
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
          coupons: [],
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
        coupons: [],
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
  return requestBaseUrl(req);
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
  const categoryName = categoryMatch && publicCategoryAllowed(categoryMatch[1])
    ? offers.find((entry) => catalogSlug(entry.category) === categoryMatch[1])?.category
    : '';
  const storeName = storeMatch ? offers.find((entry) => catalogSlug(entry.store) === storeMatch[1])?.store : '';
  const isStaticPage = pathname === '/' || pathname === '/favoritos' || pathname.startsWith('/admin') || Boolean(pages[pathname]);
  const isCatalogRoute = Boolean(offerMatch || categoryMatch || storeMatch);
  const exists = isStaticPage || Boolean(offer || categoryName || storeName);
  const page = offer
    ? [`${offer.title} — oferta no ${offer.store}`, `Confira preço, desconto e condições de ${offer.title}. A compra é concluída diretamente no ${offer.store}.`]
    : categoryName ? [`Ofertas de ${categoryName} — PromoShop`, `Compare ofertas selecionadas de ${categoryName} em lojas parceiras.`]
      : storeName ? [`Ofertas do ${storeName} — PromoShop`, `Veja ofertas e cupons selecionados do ${storeName}. Confirme as condições diretamente na loja.`]
        : pages[pathname];
  const fallbackTitle = exists
    ? String(config.seoTitle || `${config.brandName || 'PromoShop'} — Ofertas e cupons`)
    : 'Página não encontrada — PromoShop';
  const fallbackDescription = exists
    ? String(config.seoDescription || '')
    : 'Esta página não existe ou não está mais disponível.';
  return {
    title: page?.[0] || fallbackTitle,
    description: page?.[1] || fallbackDescription,
    canonical: `${origin}${pathname === '/' ? '/' : pathname}`,
    image: String(offer?.image || config.seoImageUrl || '').trim(),
    offer,
    exists,
    isOfferRoute: Boolean(offerMatch),
    isCatalogRoute
  };
}

function injectSeo(html, data, req) {
  const config = data.config || {};
  const pathname = req.path.replace(/\/+$/, '') || '/';
  const origin = publicSiteOrigin(config, req);
  const seo = pageSeo(config, pathname, origin, data.offers || []);
  const siteName = String(config.seoSiteName || config.brandName || 'PromoShop').trim();
  const noIndex = pathname.startsWith('/admin') || pathname === '/favoritos' || seo.isOfferRoute || seo.exists === false || config.seoIndexingEnabled === false;
  const schema = pathname === '/' ? buildWebsiteStructuredData(config, { origin, description: seo.description }) : null;
  const structuredData = config.seoStructuredDataEnabled === false || noIndex || !schema ? '' : `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
  const tags = [
    `<meta name="description" content="${escapeHtml(seo.description)}">`,
    `<meta name="application-name" content="${escapeHtml(siteName)}">`,
    `<meta name="apple-mobile-web-app-title" content="${escapeHtml(siteName)}">`,
    `<meta name="keywords" content="${escapeHtml(config.seoKeywords || '')}">`,
    `<meta name="robots" content="${noIndex ? (seo.isOfferRoute ? 'noindex, follow' : 'noindex, nofollow') : 'index, follow, max-image-preview:large'}">`,
    seo.exists ? `<link rel="canonical" href="${escapeHtml(seo.canonical)}">` : '',
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(seo.title)}">`,
    `<meta property="og:description" content="${escapeHtml(seo.description)}">`,
    seo.exists ? `<meta property="og:url" content="${escapeHtml(seo.canonical)}">` : '',
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
  const { config, offers, coupons } = await readStore();
  if (config.seoIndexingEnabled === false) return res.status(404).end();
  const origin = publicSiteOrigin(config, req);
  const legalLastmod = latestSeoDate([], config.legalPolicyVersion || privacyPolicyVersion);
  const eligible = (offers || []).filter((offer) => publicOfferAllowed(offer, config));
  const activeCoupons = (coupons || []).filter((coupon) => publicCouponAllowed(coupon));
  const homeLastmod = latestSeoDate([
    config.updatedAt,
    ...eligible.map((offer) => offer.updatedAt || offer.createdAt),
    ...activeCoupons.map((coupon) => coupon.updatedAt || coupon.createdAt)
  ], legalLastmod);
  const entries = new Map([
    ['/', homeLastmod],
    ['/cupons', latestSeoDate(activeCoupons.map((coupon) => coupon.updatedAt || coupon.createdAt), homeLastmod)],
    ['/sobre', legalLastmod],
    ['/contato', legalLastmod],
    ['/termos-de-uso', legalLastmod],
    ['/privacidade', legalLastmod],
    ['/exclusao-de-dados', legalLastmod]
  ]);
  for (const offer of eligible) {
    const offerLastmod = latestSeoDate([offer.updatedAt || offer.createdAt], homeLastmod);
    if (publicCategoryAllowed(offer.category)) {
      const categoryPath = `/ofertas/${catalogSlug(offer.category)}`;
      if (!categoryPath.endsWith('/')) entries.set(categoryPath, latestSeoDate([entries.get(categoryPath), offerLastmod], homeLastmod));
    }
    const storePath = `/loja/${catalogSlug(offer.store)}`;
    if (!storePath.endsWith('/')) entries.set(storePath, latestSeoDate([entries.get(storePath), offerLastmod], homeLastmod));
  }
  const urls = [...entries].map(([pathname, lastmod]) => `<url><loc>${xmlEscape(`${origin}${pathname === '/' ? '/' : pathname}`)}</loc><lastmod>${xmlEscape(lastmod)}</lastmod></url>`).join('');
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

app.get('/favicon.ico', (_req, res, next) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('png').sendFile(path.join(root, 'dist', 'favicon-48.png'), (error) => {
    if (error) next(error);
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
      // O painel não precisa de SEO renderizado no servidor. Entregue o shell
      // imediatamente para que uma leitura lenta do banco (por exemplo,
      // durante a reconexão do WhatsApp) não deixe o navegador preso no
      // carregamento; os dados do painel são buscados depois pela API.
      if (req.path.startsWith('/admin')) {
        const html = await readIndexHtml();
        res.set('Cache-Control', 'no-store');
        return res.type('html').send(injectSeo(html, { config: {} }, req));
      }

      const seoFallback = { config: {}, offers: [], seoUnavailable: true };
      const [html, data] = await Promise.all([
        readIndexHtml(),
        // SEO é um aprimoramento, não um motivo para prender o navegador.
        // Se o banco estiver ocupado, entregue o site imediatamente e deixe
        // o React buscar os dados pela API depois.
        resolveWithin(readStore(), 2_000, seoFallback)
      ]);
      const pathname = req.path.replace(/\/+$/, '') || '/';
      const seo = pageSeo(data.config || {}, pathname, publicSiteOrigin(data.config || {}, req), data.offers || []);
      const routeIsDefinitelyMissing = seo.exists === false
        && (data.seoUnavailable !== true || seo.isCatalogRoute === false);
      if (routeIsDefinitelyMissing) res.status(404);
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
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

// Não devolva stack traces, caminhos locais ou mensagens de serviços externos
// ao navegador. O detalhe fica apenas no log do servidor, já redigido.
app.use((error, _req, res, _next) => {
  console.error('Erro interno:', safeErrorMessage(error));
  if (res.headersSent) return;
  res.status(error?.status === 413 ? 413 : 500).json({ error: error?.status === 413 ? 'A solicitação excede o limite permitido.' : 'Não foi possível concluir a solicitação.' });
});

/*
 * ==========================================================
 * INICIALIZAÇÃO
 * ==========================================================
 */

const httpServer = app.listen(
  port,
  () => {
    console.log(
      `PromoShop API disponível em http://localhost:${port}`
    );
    console.log(
      `Limite de memória do servidor: ${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB.`
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

    const processInstagramQueues = async () => {
      try {
        await processInstagramQueue();
      } catch (error) {
        console.error('Instagram:', error.message);
      }
      try {
        await processInstagramFeedQueue();
      } catch (error) {
        console.error('Instagram Feed:', error.message);
      }
    };
    const instagramTimer = setInterval(() => {
      processInstagramQueues().catch((error) => console.error('Instagram:', error.message));
    }, 30_000);
    instagramTimer.unref?.();
  }
);

httpServer.requestTimeout = 120_000;
httpServer.headersTimeout = 125_000;
httpServer.keepAliveTimeout = 5_000;

let serverShutdownPromise = null;
function shutdownServer(signal) {
  if (serverShutdownPromise) return serverShutdownPromise;
  serverShutdownPromise = (async () => {
    console.log(`Encerrando PromoShop com segurança (${signal}).`);
    whatsappStopRequested = true;
    const closeHttp = new Promise((resolve) => httpServer.close(resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 10_000));
    await Promise.race([
      Promise.allSettled([stopWhatsappWorkerProcess(), closeHttp]),
      timeout
    ]);
    process.exit(0);
  })();
  return serverShutdownPromise;
}

process.once('SIGTERM', () => { void shutdownServer('SIGTERM'); });
process.once('SIGINT', () => { void shutdownServer('SIGINT'); });
