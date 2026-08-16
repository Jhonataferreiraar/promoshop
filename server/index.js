import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { addLog, createId, readStore, updateStore } from './store.js';
import { createToken, requireAdmin, requireWorker } from './auth.js';
import { collectAliexpress, collectMercadoLivre, collectShopee, makeQueueItem, runCollection } from './collectors.js';
import { readSecrets, secretStatus, updateSecrets, verifyPassword } from './secrets.js';
import { generateOfferMessage } from './ai.js';
import { beginMercadoLivreAuthorization, finishMercadoLivreAuthorization, validateMercadoLivreConnection } from './mercadolivre.js';

const app = express();
app.disable('x-powered-by');
const port = Number(process.env.PORT || 3001);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aiGenerationVersion = 4;
let whatsappProcess = null;
let whatsappRestartTimer = null;
let whatsappStopRequested = false;
let whatsappRestartAttempts = 0;
let collectionInProgress = false;
const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const loginMaxAttempts = 5;

app.set('trust proxy', 1);

function loginAttemptState(ip) {
  const now = Date.now();
  for (const [key, value] of loginAttempts) {
    if (value.resetAt <= now && value.blockedUntil <= now) loginAttempts.delete(key);
  }
  return loginAttempts.get(ip) || { count: 0, resetAt: now + loginWindowMs, blockedUntil: 0 };
}

function registerFailedLogin(ip) {
  const state = loginAttemptState(ip);
  state.count += 1;
  if (state.count >= loginMaxAttempts) state.blockedUntil = Date.now() + loginWindowMs;
  loginAttempts.set(ip, state);
  return state;
}

function whatsappAutoStartEnabled(config) {
  if (process.env.WHATSAPP_AUTOSTART !== undefined) return !['0', 'false', 'no'].includes(String(process.env.WHATSAPP_AUTOSTART).toLowerCase());
  return config.whatsappAutoStart !== false;
}

const allowedOrigins = String(process.env.SITE_URL || '').split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(null, false);
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'");
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '1mb' }));

async function startWhatsappWorker({ mode = 'qr', phoneNumber = '', automatic = false } = {}) {
  if (whatsappProcess && whatsappProcess.exitCode === null) return { started: false, message: 'Publicador já está em execução.' };
  if (whatsappRestartTimer) clearTimeout(whatsappRestartTimer);
  whatsappRestartTimer = null;
  whatsappStopRequested = false;
  const child = spawn(process.execPath, [path.join(root, 'worker', 'whatsapp.js')], {
    cwd: root,
    env: { ...process.env, PAIRING_PHONE_NUMBER: mode === 'phone' ? phoneNumber : '' },
    windowsHide: true,
    stdio: 'inherit'
  });
  whatsappProcess = child;
  child.once('exit', async (code) => {
    if (whatsappProcess === child) whatsappProcess = null;
    await updateStore((store) => {
      if (store.meta.whatsapp?.status === 'error') return;
      store.meta.whatsapp = { ...store.meta.whatsapp, status: 'offline', lastSeenAt: new Date().toISOString(), message: `Publicador encerrado (${code ?? 'sem código'}).` };
    });
    const { config } = await readStore();
    if (whatsappStopRequested || !whatsappAutoStartEnabled(config)) return;
    whatsappRestartAttempts += 1;
    const delay = Math.min(300_000, 10_000 * (2 ** Math.min(whatsappRestartAttempts - 1, 5)));
    await addLog(`WhatsApp será reiniciado automaticamente em ${Math.round(delay / 1000)} segundos.`, 'info');
    whatsappRestartTimer = setTimeout(() => {
      startWhatsappWorker({ automatic: true }).catch((error) => addLog(`Falha ao reiniciar o WhatsApp: ${error.message}`, 'error'));
    }, delay);
  });
  await updateStore((store) => {
    store.meta.whatsapp = {
      ...store.meta.whatsapp,
      status: 'starting',
      qrDataUrl: null,
      pairingCode: null,
      message: automatic ? 'Restaurando a conexão do WhatsApp…' : (mode === 'phone' ? 'Gerando código de pareamento…' : 'Gerando QR Code…')
    };
  });
  return { started: true, message: automatic ? 'Publicador iniciado automaticamente.' : (mode === 'phone' ? 'Aguarde o código de pareamento.' : 'Aguarde o QR Code.') };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString(), aiGenerationVersion, aiTextMode: 'exclusive' }));
app.get('/api/config/public', async (_req, res) => {
  const { config } = await readStore();
  const { brandName, heroTitle, heroText, primaryColor, whatsappUrl, disclosure } = config;
  res.json({ brandName, heroTitle, heroText, primaryColor, whatsappUrl, disclosure });
});
app.get('/api/offers', async (_req, res) => {
  const { offers } = await readStore();
  res.json(offers.filter((offer) => offer.status === 'active').sort((a, b) => Number(b.featured) - Number(a.featured)));
});

app.post('/api/auth/login', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const attemptState = loginAttemptState(clientIp);
  if (attemptState.blockedUntil > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((attemptState.blockedUntil - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.' });
  }
  let secrets = await readSecrets();
  if (verifyPassword('admin123', secrets.adminPasswordHash)) {
    const migrationPassword = String(process.env.ADMIN_PASSWORD || '');
    if (migrationPassword.length < 12) {
      return res.status(503).json({ error: 'A senha inicial antiga foi desativada. Defina ADMIN_PASSWORD com pelo menos 12 caracteres no ambiente.' });
    }
    secrets = await updateSecrets({ adminPassword: migrationPassword });
  }
  const expectedUser = process.env.ADMIN_USER || secrets.adminUser;
  const userOk = String(req.body.username || '') === expectedUser;
  const password = String(req.body.password || '');
  const environmentPassword = String(process.env.ADMIN_PASSWORD || '');
  if (!secrets.adminPasswordHash && environmentPassword.length < 12) {
    return res.status(503).json({ error: 'Defina ADMIN_PASSWORD com pelo menos 12 caracteres antes do primeiro acesso.' });
  }
  const passOk = secrets.adminPasswordHash
    ? verifyPassword(password, secrets.adminPasswordHash)
    : environmentPassword && password.length === environmentPassword.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(environmentPassword));
  if (!userOk || !passOk) {
    registerFailedLogin(clientIp);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  loginAttempts.delete(clientIp);
  res.json({ token: createToken(expectedUser, secrets.adminSessionVersion) });
});

app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  const data = await readStore();
  const secrets = await readSecrets();
  const lastSeen = data.meta.whatsapp?.lastSeenAt ? new Date(data.meta.whatsapp.lastSeenAt).getTime() : 0;
  if (Date.now() - lastSeen > 90_000 && data.meta.whatsapp?.status === 'connected') data.meta.whatsapp.status = 'offline';
  res.json({ ...data, secrets: secretStatus(secrets) });
});
app.put('/api/admin/config', requireAdmin, async (req, res) => {
  await updateStore((data) => {
    const writingStyleChanged = ('aiTone' in req.body && req.body.aiTone !== data.config.aiTone)
      || ('aiInstructions' in req.body && req.body.aiInstructions !== data.config.aiInstructions)
      || ('messageTemplate' in req.body && req.body.messageTemplate !== data.config.messageTemplate);
    data.config = { ...data.config, ...req.body };
    if (writingStyleChanged) {
      for (const item of data.queue) {
        if (item.status !== 'pending') continue;
        delete item.aiStatus;
        delete item.aiError;
        delete item.aiGeneratedAt;
        delete item.aiGenerationVersion;
        delete item.aiRetryAt;
        item.message = '';
        item.messageSource = 'awaiting-ai';
      }
    }
  });
  await addLog('Configurações atualizadas.', 'success');
  res.json({ ok: true });
});
app.put('/api/admin/secrets', requireAdmin, async (req, res) => {
  if (req.body?.adminPassword && String(req.body.adminPassword).length < 12) {
    return res.status(400).json({ error: 'A nova senha deve ter pelo menos 12 caracteres.' });
  }
  const updated = await updateSecrets(req.body || {});
  await addLog('Credenciais protegidas foram atualizadas.', 'success');
  res.json(secretStatus(updated));
});
app.post('/api/admin/sources/mercadolivre/connect', requireAdmin, async (req, res) => {
  try {
    const configured = String(req.body.redirectUri || '').trim();
    const fallbackOrigin = String(process.env.RENDER_EXTERNAL_URL || process.env.SITE_URL || '').split(',')[0].replace(/\/$/, '');
    const redirectUri = configured || (fallbackOrigin ? `${fallbackOrigin}/api/mercadolivre/callback` : '');
    let parsed;
    try { parsed = new URL(redirectUri); } catch { }
    if (!parsed || parsed.protocol !== 'https:' || parsed.pathname !== '/api/mercadolivre/callback' || parsed.search || parsed.hash) {
      return res.status(400).json({ error: 'Informe uma URL HTTPS terminada exatamente em /api/mercadolivre/callback.' });
    }
    const authorizationUrl = await beginMercadoLivreAuthorization(redirectUri);
    res.json({ ok: true, authorizationUrl, redirectUri });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.get('/api/mercadolivre/callback', async (req, res) => {
  if (req.query.error) {
    await addLog(`Mercado Livre: autorização cancelada (${String(req.query.error).slice(0, 100)}).`, 'error');
    return res.redirect('/admin?mercadolivre=cancelled');
  }
  try {
    await finishMercadoLivreAuthorization({ code: String(req.query.code || ''), state: String(req.query.state || '') });
    await addLog('Conta do Mercado Livre conectada e renovação automática ativada.', 'success');
    res.redirect('/admin?mercadolivre=connected');
  } catch (error) {
    await addLog(`Mercado Livre: falha na autorização (${error.message}).`, 'error');
    res.redirect('/admin?mercadolivre=error');
  }
});
app.post('/api/admin/sources/mercadolivre/test', requireAdmin, async (_req, res) => {
  try {
    const user = await validateMercadoLivreConnection();
    const { config } = await readStore();
    const offers = await collectMercadoLivre({ ...config, enableMercadoLivre: true }, await readSecrets());
    res.json({ ok: true, userId: user.id, nickname: user.nickname || '', count: offers.length, sample: offers[0]?.title || null });
  } catch (error) {
    res.status(400).json({ error: `Mercado Livre: ${error.message}` });
  }
});
app.post('/api/admin/offers', requireAdmin, async (req, res) => {
  const offer = { ...req.body, id: createId('offer'), price: Number(req.body.price), originalPrice: Number(req.body.originalPrice || 0), createdAt: new Date().toISOString(), source: 'manual' };
  if (!offer.title || !offer.price || !offer.affiliateUrl) return res.status(400).json({ error: 'Produto, preço e link são obrigatórios.' });
  await updateStore((data) => data.offers.unshift(offer));
  await addLog(`Oferta adicionada: ${offer.title}`, 'success');
  res.status(201).json(offer);
});
app.put('/api/admin/offers/:id', requireAdmin, async (req, res) => {
  let updated;
  await updateStore((data) => {
    const offer = data.offers.find((item) => item.id === req.params.id);
    if (!offer) return;
    const allowed = ['title', 'category', 'price', 'originalPrice', 'image', 'affiliateUrl', 'freeShipping', 'featured', 'status'];
    for (const key of allowed) if (key in req.body) offer[key] = req.body[key];
    updated = offer;
  });
  if (!updated) return res.status(404).json({ error: 'Oferta não encontrada.' });
  await addLog(`Oferta atualizada: ${updated.title}`, 'success');
  res.json(updated);
});
app.delete('/api/admin/offers/:id', requireAdmin, async (req, res) => {
  await updateStore((data) => { data.offers = data.offers.filter((offer) => offer.id !== req.params.id); });
  await addLog('Oferta removida.');
  res.json({ ok: true });
});
app.post('/api/admin/offers/:id/queue', requireAdmin, async (req, res) => {
  let queueItem;
  await updateStore((data) => {
    const offer = data.offers.find((item) => item.id === req.params.id);
    if (!offer) return;
    if (offer.status !== 'active') return;
    queueItem = { ...makeQueueItem(offer, data.config), force: Boolean(req.body.force) };
    data.queue.push(queueItem);
  });
  if (!queueItem) return res.status(400).json({ error: 'A oferta precisa ter um link afiliado confirmado antes do envio.' });
  await addLog(`${queueItem.force ? 'Publicação forçada' : 'Oferta enviada para a fila'}: ${queueItem.offerTitle}`, queueItem.force ? 'success' : 'info');
  res.status(201).json(queueItem);
});
app.post('/api/admin/collect', requireAdmin, async (_req, res) => res.json(await runCollection()));
app.post('/api/admin/sources/shopee/test', requireAdmin, async (_req, res) => {
  const { config } = await readStore();
  const secrets = await readSecrets();
  try {
    const offers = await collectShopee({ ...config, enableShopee: true }, secrets);
    res.json({ ok: true, count: offers.length, sample: offers[0]?.title || null });
  } catch (error) {
    res.status(400).json({ error: `Shopee: ${error.message}` });
  }
});
app.post('/api/admin/sources/aliexpress/test', requireAdmin, async (_req, res) => {
  const { config } = await readStore();
  const secrets = await readSecrets();
  try {
    const offers = await collectAliexpress({ ...config, enableAliexpress: true }, secrets);
    res.json({ ok: true, count: offers.length, sample: offers[0]?.title || null });
  } catch (error) {
    res.status(400).json({ error: `AliExpress: ${error.message}` });
  }
});
app.post('/api/admin/ai/test', requireAdmin, async (_req, res) => {
  const data = await readStore();
  const offer = data.offers.find((item) => item.status === 'active' && item.affiliateUrl);
  if (!offer) return res.status(400).json({ error: 'Cadastre uma oferta ativa antes de testar a IA.' });
  try {
    const message = await generateOfferMessage(offer, data.config);
    await updateStore((store) => {
      for (const item of store.queue) {
        if (item.status === 'pending' && ['fallback', 'waiting'].includes(item.aiStatus)) {
          delete item.aiStatus;
          delete item.aiError;
          delete item.aiRetryAt;
        }
      }
    });
    res.json({ ok: true, message, offerTitle: offer.title });
  } catch (error) {
    res.status(400).json({ error: `IA: ${error.message}` });
  }
});
app.delete('/api/admin/queue/:id', requireAdmin, async (req, res) => {
  await updateStore((data) => { data.queue = data.queue.filter((item) => item.id !== req.params.id || item.status === 'sent'); });
  await addLog('Item removido da fila.');
  res.json({ ok: true });
});
app.post('/api/admin/queue/:id/force', requireAdmin, async (req, res) => {
  let item;
  await updateStore((data) => {
    item = data.queue.find((entry) => entry.id === req.params.id && entry.status === 'pending');
    if (item) item.force = true;
  });
  if (!item) return res.status(404).json({ error: 'Item pendente não encontrado.' });
  await addLog(`Publicação priorizada para envio imediato: ${item.offerTitle}`, 'success');
  res.json({ ok: true });
});
app.post('/api/admin/queue/:id/retry', requireAdmin, async (req, res) => {
  let item;
  await updateStore((data) => {
    item = data.queue.find((entry) => entry.id === req.params.id && entry.status === 'failed');
    if (item) {
      item.status = 'pending';
      item.force = true;
      item.error = null;
      item.failedAt = null;
    }
  });
  if (!item) return res.status(404).json({ error: 'Publicação com falha não encontrada.' });
  await addLog(`Nova tentativa priorizada: ${item.offerTitle}`, 'success');
  res.json({ ok: true });
});
app.post('/api/admin/whatsapp/start', requireAdmin, async (req, res) => {
  const mode = req.body.mode === 'phone' ? 'phone' : 'qr';
  const phoneNumber = String(req.body.phoneNumber || '').replace(/\D/g, '');
  if (mode === 'phone' && (phoneNumber.length < 10 || phoneNumber.length > 15)) return res.status(400).json({ error: 'Informe o número com código do país e DDD, somente números.' });
  const result = await startWhatsappWorker({ mode, phoneNumber });
  res.json({ ok: true, message: result.message });
});
app.post('/api/admin/whatsapp/stop', requireAdmin, async (_req, res) => {
  whatsappStopRequested = true;
  if (whatsappRestartTimer) clearTimeout(whatsappRestartTimer);
  whatsappRestartTimer = null;
  if (whatsappProcess && whatsappProcess.exitCode === null) whatsappProcess.kill();
  whatsappProcess = null;
  await updateStore((store) => { store.meta.whatsapp = { ...store.meta.whatsapp, status: 'offline', qrDataUrl: null, pairingCode: null, message: 'Publicador parado pelo painel.' }; });
  res.json({ ok: true });
});

app.get('/api/worker/queue/next', requireWorker, async (req, res) => {
  const { config, queue, offers } = await readStore();
  const now = new Date();
  const forced = queue.find((item) => item.status === 'pending' && item.force);
  async function prepareWithAi(item) {
    if (!item || config.aiEnabled === false) return null;
    if (item.aiStatus === 'generated'
      && item.messageSource === 'ai'
      && Number(item.aiGenerationVersion) >= aiGenerationVersion
      && item.message) return item;
    if (item.aiStatus === 'waiting' && new Date(item.aiRetryAt || 0).getTime() > Date.now()) return null;
    try {
      const offer = offers.find((entry) => entry.id === item.offerId) || item.offerSnapshot;
      if (!offer?.title || !offer?.affiliateUrl || !Number(offer?.price)) {
        throw new Error('Os dados completos do produto não estão mais disponíveis para a IA.');
      }
      const message = await generateOfferMessage({ ...offer, publicationId: item.id }, config);
      await updateStore((data) => {
        const saved = data.queue.find((entry) => entry.id === item.id && entry.status === 'pending');
        if (saved) { saved.message = message; saved.messageSource = 'ai'; saved.aiStatus = 'generated'; saved.aiGenerationVersion = aiGenerationVersion; saved.aiGeneratedAt = new Date().toISOString(); delete saved.aiError; delete saved.aiRetryAt; }
      });
      await addLog(`IA criou o texto da oferta: ${item.offerTitle}`, 'success');
      return { ...item, message, messageSource: 'ai', aiStatus: 'generated', aiGenerationVersion };
    } catch (error) {
      const errorMessage = String(error.message || 'Erro desconhecido');

      if (errorMessage === 'Os dados completos do produto não estão mais disponíveis para a IA.') {
        await updateStore((data) => {
          const saved = data.queue.find(
            (entry) => entry.id === item.id && entry.status === 'pending'
          );

          if (saved) {
            saved.status = 'failed';
            saved.force = false;
            saved.message = '';
            saved.messageSource = 'awaiting-ai';
            saved.aiStatus = 'failed';
            saved.aiError = errorMessage.slice(0, 300);
            saved.failedAt = new Date().toISOString();
            delete saved.aiRetryAt;
          }
        });

        await addLog(
          `IA pulou ${item.offerTitle}: dados do produto indisponíveis. A fila seguirá para a próxima oferta válida.`,
          'error'
        );

        return { skipped: true };
      }

      const retryAt = new Date(Date.now() + 60_000).toISOString();

      await updateStore((data) => {
        const saved = data.queue.find(
          (entry) => entry.id === item.id && entry.status === 'pending'
        );

        if (saved) {
          saved.message = '';
          saved.messageSource = 'awaiting-ai';
          saved.aiStatus = 'waiting';
          saved.aiError = errorMessage.slice(0, 300);
          saved.aiRetryAt = retryAt;
        }
      });

      await addLog(
        `IA não criou o texto de ${item.offerTitle}; nova tentativa em 1 minuto (${errorMessage}).`,
        'error'
      );

      return null;
    }
  }
  if (req.query.forced === '1') {
    const prepared = forced ? await prepareWithAi(forced) : null;

    if (prepared && !prepared.skipped) {
      return res.json(prepared);
    }

    return res.status(204).end();
  }
  if (forced) {
    const prepared = await prepareWithAi(forced);

    if (prepared && !prepared.skipped) {
      return res.json(prepared);
    }

    if (!prepared) {
      return res.status(204).end();
    }
  }
  const hourMinute = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false });
  const publishingStart = config.publishingStart || config.quietEnd || '08:00';
  const publishingEnd = config.publishingEnd || config.quietStart || '23:00';
  const isPublishingTime = publishingStart === publishingEnd
    || (publishingStart < publishingEnd
      ? hourMinute >= publishingStart && hourMinute < publishingEnd
      : hourMinute >= publishingStart || hourMinute < publishingEnd);
  if (!isPublishingTime) return res.status(204).end();
  const sentToday = queue.filter((item) => item.status === 'sent' && item.sentAt?.slice(0, 10) === now.toISOString().slice(0, 10)).length;
  if (sentToday >= Number(config.maxPostsPerDay || 10)) return res.status(204).end();
  const intervalMinutes = [5, 10, 15, 20, 25, 30].includes(Number(config.whatsappIntervalMinutes)) ? Number(config.whatsappIntervalMinutes) : 15;
  const lastSentAt = queue.filter((item) => item.status === 'sent' && item.sentAt).reduce((latest, item) => Math.max(latest, new Date(item.sentAt).getTime()), 0);
  if (lastSentAt && now.getTime() - lastSentAt < intervalMinutes * 60_000) return res.status(204).end();
  const pendingItems = queue.filter(
    (item) => item.status === 'pending' && !item.force
  );

  for (const item of pendingItems) {
    const prepared = await prepareWithAi(item);

    if (prepared?.skipped) {
      continue;
    }

    if (prepared) {
      return res.json(prepared);
    }

    return res.status(204).end();
  }

  return res.status(204).end();
});
app.get('/api/worker/config', requireWorker, async (_req, res) => {
  const { config } = await readStore();
  const selectedGroups = Array.isArray(config.whatsappGroups)
    ? config.whatsappGroups
      .slice(0, 100)
      .map((group) => ({ id: String(group.id || '').slice(0, 120), name: String(group.name || '').slice(0, 160) }))
      .filter((group) => group.id)
    : [];
  if (!selectedGroups.length && config.whatsappGroupId) selectedGroups.push({ id: config.whatsappGroupId, name: config.whatsappGroupName || '' });
  res.json({ selectedGroups, groupId: config.whatsappGroupId || '', groupName: config.whatsappGroupName || '', maxPerHour: Number(config.whatsappMaxPerHour || 10) });
});
app.post('/api/worker/groups', requireWorker, async (req, res) => {
  const groups = Array.isArray(req.body.groups) ? req.body.groups.slice(0, 500).map((group) => ({ id: String(group.id || '').slice(0, 120), name: String(group.name || '').slice(0, 160) })).filter((group) => group.id && group.name) : [];
  await updateStore((data) => { data.meta.whatsapp = { ...data.meta.whatsapp, groups, lastSeenAt: new Date().toISOString() }; });
  await addLog(`WhatsApp: ${groups.length} grupos encontrados.`, 'success');
  res.json({ ok: true, count: groups.length });
});
app.post('/api/worker/qr', requireWorker, async (req, res) => {
  if (!req.body.qr) return res.status(400).json({ error: 'QR Code ausente.' });
  const qrDataUrl = await QRCode.toDataURL(req.body.qr, { width: 320, margin: 2 });
  await updateStore((data) => { data.meta.whatsapp = { ...data.meta.whatsapp, status: 'qr', lastSeenAt: new Date().toISOString(), qrDataUrl, pairingCode: null, message: 'Leia o QR Code com o WhatsApp.' }; });
  res.json({ ok: true });
});
app.post('/api/worker/pairing-code', requireWorker, async (req, res) => {
  const pairingCode = String(req.body.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 12);
  if (!pairingCode) return res.status(400).json({ error: 'Código ausente.' });
  await updateStore((data) => { data.meta.whatsapp = { ...data.meta.whatsapp, status: 'pairing', lastSeenAt: new Date().toISOString(), qrDataUrl: null, pairingCode, message: 'Digite este código no WhatsApp do celular.' }; });
  res.json({ ok: true });
});
app.post('/api/worker/heartbeat', requireWorker, async (req, res) => {
  const status = ['starting', 'qr', 'pairing', 'authenticated', 'connected', 'offline', 'error'].includes(req.body.status) ? req.body.status : 'starting';
  if (status === 'connected') whatsappRestartAttempts = 0;
  await updateStore((data) => { data.meta.whatsapp = { ...data.meta.whatsapp, status, lastSeenAt: new Date().toISOString(), qrDataUrl: ['authenticated', 'connected'].includes(status) ? null : data.meta.whatsapp.qrDataUrl, pairingCode: status === 'connected' ? null : data.meta.whatsapp.pairingCode, message: String(req.body.message || '').slice(0, 200) }; });
  res.json({ ok: true });
});
app.post('/api/worker/queue/:id/complete', requireWorker, async (req, res) => {
  await updateStore((data) => { const item = data.queue.find((entry) => entry.id === req.params.id); if (item) { item.status = 'sent'; item.sentAt = new Date().toISOString(); item.error = null; } });
  await addLog(`WhatsApp: publicação enviada (${req.params.id}).`, 'success');
  res.json({ ok: true });
});
app.post('/api/worker/queue/:id/fail', requireWorker, async (req, res) => {
  await updateStore((data) => { const item = data.queue.find((entry) => entry.id === req.params.id); if (item) { item.attempts += 1; item.status = item.attempts >= 3 ? 'failed' : 'pending'; item.error = String(req.body.error || 'Falha desconhecida').slice(0, 500); } });
  await addLog(`WhatsApp: falha ao publicar (${String(req.body.error || 'erro')}).`, 'error');
  res.json({ ok: true });
});

app.use(express.static(path.join(root, 'dist')));
app.use((_req, res, next) => {
  if (_req.path.startsWith('/api')) return next();
  res.sendFile(path.join(root, 'dist', 'index.html'));
});

cron.schedule('* * * * *', async () => {
  if (collectionInProgress) return;
  const data = await readStore();
  const interval = Math.max(5, Number(data.config.collectionIntervalMinutes || 15));
  const last = data.meta.lastCollectionAt ? new Date(data.meta.lastCollectionAt).getTime() : 0;
  if (Date.now() - last < interval * 60_000) return;
  collectionInProgress = true;
  try { await runCollection(); }
  catch (error) { await addLog(`Erro no agendador: ${error.message}`, 'error'); }
  finally { collectionInProgress = false; }
});

app.listen(port, () => {
  console.log(`PromoShop API disponível em http://localhost:${port}`);
  setTimeout(async () => {
    try {
      const { config } = await readStore();
      if (whatsappAutoStartEnabled(config)) await startWhatsappWorker({ automatic: true });
    } catch (error) {
      await addLog(`Não foi possível iniciar o WhatsApp automaticamente: ${error.message}`, 'error');
    }
  }, 2000);
});
