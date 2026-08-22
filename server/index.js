import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getAiAvailability,
  recommendWhatsappAudiences
} from './ai.js';

import {
  beginMercadoLivreAuthorization,
  finishMercadoLivreAuthorization,
  validateMercadoLivreConnection
} from './mercadolivre.js';

import {
  getAudienceCodesForOffer
} from './audienceRouting.js';

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

const loginAttempts = new Map();

const loginWindowMs =
  15 * 60 * 1000;

const loginMaxAttempts = 5;

const assistantAttempts = new Map();

const assistantWindowMs =
  10 * 60 * 1000;

const assistantMaxAttempts = 10;

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
  }
  if (coupon?.link) parts.push(`👉 Ative aqui: ${coupon.link}`);
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
  let result = null;

  await updateStore(
    (data) => {
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
      disclosure
    } = config;

    /*
     * Apenas consulta o estado.
     *
     * NÃO faz chamada para Gemini,
     * OpenAI ou Groq.
     */
    const aiStatus =
      getAiAvailability();

    res.json({
      brandName,
      heroTitle,
      heroText,
      primaryColor,
      whatsappUrl,
      disclosure,

      assistantAvailable:
        Boolean(
          config.aiEnabled !== false &&
          aiStatus.available
        )
    });
  }
);

app.get(
  '/api/offers',
  async (
    _req,
    res
  ) => {
    const {
      offers
    } =
      await readStore();

    res.json(
      offers
        .filter(
          (offer) =>
            offer.status ===
            'active'
        )
        .sort(
          (a, b) =>
            Number(
              b.featured
            ) -
            Number(
              a.featured
            )
        )
    );
  }
);

app.get(
  '/api/coupons',
  async (_req, res) => {
    const { coupons } = await readStore();
    const now = Date.now();

    res.json(
      (Array.isArray(coupons) ? coupons : [])
        .filter((coupon) => {
          if (coupon.active === false) return false;
          if (!coupon.expiresAt) return true;
          const expiresAt = new Date(coupon.expiresAt).getTime();
          return Number.isNaN(expiresAt) || expiresAt >= now;
        })
        .sort((a, b) => Number(b.featured) - Number(a.featured) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 100)
        .map(({ targetAudienceCodes, ...coupon }) => coupon)
    );
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

app.get(
  '/api/admin/dashboard',
  requireAdmin,
  async (
    _req,
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
            limit
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
            limit
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

    res.json({
      query,

      count:
        results.length,

      results,
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

        const allowed = [
          'title',
          'category',
          'price',
          'originalPrice',
          'image',
          'affiliateUrl',
          'freeShipping',
          'featured',
          'status'
        ];

        for (
          const key
          of allowed
        ) {
          if (
            key in req.body
          ) {
            offer[key] =
              req.body[key];
          }
        }

        offer.targetAudienceCodes =
          getAudienceCodesForOffer(
            offer,
            data.config
              .whatsappAudiences
          );

        updated =
          offer;
      }
    );

    if (!updated) {
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

/*
 * ==========================================================
 * CUPONS
 * ==========================================================
 */

app.post(
  '/api/admin/coupons',
  requireAdmin,
  async (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 180);
    const link = String(req.body?.link || '').trim().slice(0, 1000);
    const description = String(req.body?.description || '').trim().slice(0, 500);
    const code = String(req.body?.code || '').trim().slice(0, 80);
    const store = String(req.body?.store || 'Magalu').trim().slice(0, 60) || 'Magalu';
    const discountType = ['percent', 'fixed', 'free-shipping'].includes(req.body?.discountType)
      ? req.body.discountType
      : 'percent';
    const rawDiscountValue = Number(req.body?.discountValue || 0);
    const rawMinPurchase = Number(req.body?.minPurchase || 0);
    const discountValue = Number.isFinite(rawDiscountValue) ? Math.max(0, rawDiscountValue) : 0;
    const minPurchase = Number.isFinite(rawMinPurchase) ? Math.max(0, rawMinPurchase) : 0;
    const targetAudienceCodes = normalizeCouponAudienceCodes(req.body?.targetAudienceCodes);
    const expiresAtDate = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;

    let parsedLink;
    try { parsedLink = new URL(link); } catch { parsedLink = null; }

    if (!title || !parsedLink || !['http:', 'https:'].includes(parsedLink.protocol)) {
      return res.status(400).json({ error: 'Informe o título e um link HTTPS válido para o cupom.' });
    }
    if (!targetAudienceCodes.length) {
      return res.status(400).json({ error: 'Selecione pelo menos um grupo para este cupom.' });
    }
    if (expiresAtDate && Number.isNaN(expiresAtDate.getTime())) {
      return res.status(400).json({ error: 'Informe uma validade correta para o cupom.' });
    }

    const coupon = {
      id: createId('coupon'),
      title,
      store,
      code,
      description,
      discountType,
      discountValue,
      minPurchase,
      expiresAt: expiresAtDate ? expiresAtDate.toISOString() : null,
      link,
      image: String(req.body?.image || '').trim().slice(0, 1000),
      featured: req.body?.featured !== false,
      active: req.body?.active !== false,
      targetAudienceCodes,
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await updateStore((data) => {
      data.coupons ||= [];
      data.coupons.unshift(coupon);
      data.coupons = data.coupons.slice(0, 300);
    });

    await addLog(`Cupom cadastrado: ${coupon.title} → ${coupon.targetAudienceCodes.join(', ')}`, 'success');
    return res.status(201).json(coupon);
  }
);

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
      const message = formatCouponMessage(coupon);
      queueItem = {
        id: createId('queue'),
        kind: 'coupon',
        couponId: coupon.id,
        offerId: null,
        offerTitle: coupon.title,
        store: coupon.store || 'Magalu',
        targetAudienceCodes,
        couponSnapshot: { ...coupon, targetAudienceCodes },
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
      await runCollection()
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

          const message = String(item.message || formatCouponMessage(coupon)).trim();
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

      const data =
        await readStore();

      const secrets =
        await readSecrets();

      const audiences =
        Array.isArray(
          data.config
            .whatsappAudiences
        )
          ? data.config
              .whatsappAudiences
          : [];

      const recommendation =
        await recommendWhatsappAudiences(
          message,
          audiences,
          data.config,
          secrets
        );

      const recommendedAudiences =
        recommendation.codes
          .map(
            (code) =>
              audiences.find(
                (audience) =>
                  normalizeAudienceCode(
                    audience.code
                  ) ===
                  normalizeAudienceCode(
                    code
                  )
              )
          )
          .filter(
            (audience) =>
              audience &&
              audience.enabled !==
                false &&
              audience
                .whatsappLink
          )
          .map(
            (audience) => ({
              code:
                audience.code,

              name:
                audience.name,

              whatsappLink:
                audience
                  .whatsappLink
            })
          );

      res.json({
        message:
          recommendation.message,

        audiences:
          recommendedAudiences
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
            'Não consegui encontrar um grupo agora. Tente novamente em alguns instantes.'
        });
    }
  }
);

/*
 * ==========================================================
 * FRONTEND
 * ==========================================================
 */

app.use(
  express.static(
    path.join(
      root,
      'dist'
    )
  )
);

app.use(
  (
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

    res.sendFile(
      path.join(
        root,
        'dist',
        'index.html'
      )
    );
  }
);

/*
 * ==========================================================
 * COLETA AUTOMÁTICA
 * ==========================================================
 */

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
      Date.now() -
      last <
      interval *
      60_000
    ) {
      return;
    }

    collectionInProgress =
      true;

    try {
      await runCollection();
    } catch (error) {
      await addLog(
        `Erro no agendador: ${error.message}`,
        'error'
      );
    } finally {
      collectionInProgress =
        false;
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
  }
);
