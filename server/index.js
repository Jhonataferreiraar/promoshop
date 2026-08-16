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
import { collectAliexpress, collectShopee, makeQueueItem, runCollection } from './collectors.js';
import { readSecrets, secretStatus, updateSecrets, verifyPassword } from './secrets.js';
import { generateOfferMessage } from './ai.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let whatsappProcess = null;
let whatsappRestartTimer = null;
let whatsappStopRequested = false;
let whatsappRestartAttempts = 0;
let collectionInProgress = false;

function whatsappAutoStartEnabled(config) {
  if (process.env.WHATSAPP_AUTOSTART !== undefined) return !['0', 'false', 'no'].includes(String(process.env.WHATSAPP_AUTOSTART).toLowerCase());
  return config.whatsappAutoStart !== false;
}

app.use(cors({ origin: process.env.SITE_URL ? process.env.SITE_URL.split(',') : true }));
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

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
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
  const secrets = await readSecrets();
  const expectedUser = process.env.ADMIN_USER || secrets.adminUser;
  const userOk = String(req.body.username || '') === expectedUser;
  const password = String(req.body.password || '');
  const passOk = process.env.ADMIN_PASSWORD
    ? password.length === process.env.ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(process.env.ADMIN_PASSWORD))
    : verifyPassword(password, secrets.adminPasswordHash);
  if (!userOk || !passOk) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  res.json({ token: createToken(expectedUser) });
});

app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  const data = await readStore();
  const secrets = await readSecrets();
  const lastSeen = data.meta.whatsapp?.lastSeenAt ? new Date(data.meta.whatsapp.lastSeenAt).getTime() : 0;
  if (Date.now() - lastSeen > 90_000 && data.meta.whatsapp?.status === 'connected') data.meta.whatsapp.status = 'offline';
  res.json({ ...data, secrets: secretStatus(secrets) });
});
app.put('/api/admin/config', requireAdmin, async (req, res) => {
  await updateStore((data) => { data.config = { ...data.config, ...req.body }; });
  await addLog('Configurações atualizadas.', 'success');
  res.json({ ok: true });
});
app.put('/api/admin/secrets', requireAdmin, async (req, res) => {
  const updated = await updateSecrets(req.body || {});
  await addLog('Credenciais protegidas foram atualizadas.', 'success');
  res.json(secretStatus(updated));
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
        if (item.status === 'pending' && item.aiStatus === 'fallback') {
          delete item.aiStatus;
          delete item.aiError;
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
    if (!item || !config.aiEnabled || item.aiStatus === 'generated' || item.aiStatus === 'fallback') return item;
    const offer = offers.find((entry) => entry.id === item.offerId);
    if (!offer) return item;
    try {
      const message = await generateOfferMessage(offer, config);
      await updateStore((data) => {
        const saved = data.queue.find((entry) => entry.id === item.id && entry.status === 'pending');
        if (saved) { saved.message = message; saved.aiStatus = 'generated'; saved.aiGeneratedAt = new Date().toISOString(); }
      });
      await addLog(`IA criou o texto da oferta: ${item.offerTitle}`, 'success');
      return { ...item, message, aiStatus: 'generated' };
    } catch (error) {
      await updateStore((data) => {
        const saved = data.queue.find((entry) => entry.id === item.id && entry.status === 'pending');
        if (saved) { saved.aiStatus = 'fallback'; saved.aiError = String(error.message).slice(0, 300); }
      });
      await addLog(`IA indisponível; usando texto padrão para ${item.offerTitle} (${error.message}).`, 'error');
      return { ...item, aiStatus: 'fallback' };
    }
  }
  if (req.query.forced === '1') return forced ? res.json(await prepareWithAi(forced)) : res.status(204).end();
  if (forced) return res.json(await prepareWithAi(forced));
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
  const next = queue.find((item) => item.status === 'pending');
  if (!next) return res.status(204).end();
  res.json(await prepareWithAi(next));
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
