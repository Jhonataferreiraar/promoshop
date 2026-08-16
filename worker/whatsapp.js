import 'dotenv/config';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecrets } from '../server/secrets.js';
import { readStore } from '../server/store.js';

const { Client, LocalAuth } = pkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiUrl = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
const authDataPath = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(process.env.WHATSAPP_AUTH_DIR)
  : process.env.DATA_DIR
    ? path.join(path.resolve(process.env.DATA_DIR), 'whatsapp-auth')
    : path.join(root, '.wwebjs_auth');

function clearStaleBrowserLocks() {
  const sessionPath = path.join(authDataPath, 'session-promoshop');
  for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { rmSync(path.join(sessionPath, lockName), { force: true }); }
    catch (error) { console.warn(`Não foi possível remover ${lockName}: ${error.message}`); }
  }
}
const pairingPhoneNumber = String(process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');
const storedSecrets = await readSecrets();
const workerToken = process.env.WORKER_TOKEN || storedSecrets.workerToken;
let groupId = '';
let groupName = '';
let selectedGroups = [];
let maxPerHour = 10;
const initialStore = await readStore();
const chromiumArgs = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-software-rasterizer',
  '--disable-default-apps',
  '--disable-sync',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-zygote',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=128'
];
const chromiumSandboxDisabled = process.env.CHROME_DISABLE_SANDBOX === 'true'
  || (typeof process.getuid === 'function' && process.getuid() === 0);
if (chromiumSandboxDisabled) chromiumArgs.unshift('--no-sandbox', '--disable-setuid-sandbox');
const browserPath = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/snap/bin/chromium'
].find((candidate) => existsSync(candidate));

if (!workerToken) {
  console.error('Não foi possível carregar a identificação segura do publicador.');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'promoshop', dataPath: authDataPath }),
  ...(pairingPhoneNumber ? { pairWithPhoneNumber: { phoneNumber: pairingPhoneNumber, showNotification: true, intervalMs: 180000 } } : {}),
  puppeteer: {
    headless: Boolean(initialStore.config.whatsappHeadless),
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: chromiumArgs
  }
});

let sentTimes = [];
let processing = false;
let connectedServicesStarted = false;

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'x-worker-token': workerToken, ...(options.headers || {}) } });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`API respondeu ${response.status}`);
  return response.json();
}

async function refreshConfig() {
  const config = await request('/api/worker/config');
  groupId = config.groupId || '';
  groupName = config.groupName || '';
  selectedGroups = Array.isArray(config.selectedGroups) ? config.selectedGroups.filter((group) => group.id) : [];
  if (!selectedGroups.length && groupId) selectedGroups = [{ id: groupId, name: groupName }];
  maxPerHour = Number(config.maxPerHour || 10);
}

async function refreshActivePage() {
  const pages = await client.pupBrowser.pages();
  const activePage = pages.find((page) => page.url().includes('web.whatsapp.com'));
  if (!activePage) throw new Error('A página ativa do WhatsApp Web não foi encontrada.');
  client.pupPage = activePage;
  await activePage.waitForFunction(() => Boolean(window.WWebJS && window.require), { timeout: 15_000 });
  return activePage;
}

async function listGroups() {
  const page = await refreshActivePage();
  return page.evaluate(() => {
    const collection = window.require?.('WAWebCollections')?.Chat || window.Store?.Chat;
    const chats = collection?.getModelsArray?.() || collection?.models || [];
    return chats
      .map((chat) => ({
        id: chat.id?._serialized || `${chat.id?.user}@${chat.id?.server}`,
        name: chat.name || chat.formattedTitle || chat.contact?.name || 'Grupo sem nome'
      }))
      .filter((chat) => chat.id.endsWith('@g.us'));
  });
}

async function syncGroups(attempt = 1) {
  try {
    const groups = (await listGroups()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    await request('/api/worker/groups', { method: 'POST', body: JSON.stringify({ groups }) });
    const message = selectedGroups.length
      ? `Conectado. ${selectedGroups.length} grupo${selectedGroups.length === 1 ? '' : 's'} selecionado${selectedGroups.length === 1 ? '' : 's'} para publicação.`
      : `${groups.length} grupos encontrados. Escolha um no painel.`;
    await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'connected', message }) });
    console.log(`WhatsApp conectado. ${groups.length} grupos disponíveis.`);
  } catch (error) {
    console.error(`Tentativa ${attempt} de carregar grupos falhou:`, error.message);
    await request('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ status: 'connected', message: 'WhatsApp conectado. Carregando a lista de grupos…' })
    }).catch(() => {});
    if (attempt < 12) setTimeout(() => syncGroups(attempt + 1), 10_000);
  }
}

async function startConnectedServices() {
  if (connectedServicesStarted) return;
  connectedServicesStarted = true;
  await request('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ status: 'connected', message: 'WhatsApp conectado. Carregando a lista de grupos…' })
  }).catch(() => {});
  await refreshConfig().catch((error) => console.error('Não foi possível carregar as configurações:', error.message));
  await syncGroups();
  processQueue();
  setInterval(() => processQueue(true), 500);
  setInterval(() => processQueue(false), 15_000);
  setInterval(() => {
    request('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ status: 'connected', message: 'WhatsApp conectado e publicador ativo.' })
    }).catch((error) => console.error('Falha ao atualizar o estado da conexão:', error.message));
  }, 30_000);
}

async function resolveDestinations() {
  if (selectedGroups.length) return selectedGroups;
  if (groupId) return [{ id: groupId, name: groupName }];
  if (!groupName) return [];
  const groups = await listGroups();
  const match = groups.find((group) => group.name.trim().toLowerCase() === groupName.trim().toLowerCase());
  return match ? [match] : [];
}

async function processQueue(forcedOnly = false) {
  if (processing) return;
  processing = true;
  let item = null;
  try {
    await refreshConfig();
    if (!selectedGroups.length && !groupId && !groupName) return;
    item = await request(`/api/worker/queue/next${forcedOnly ? '?forced=1' : ''}`);
    if (!item) return;
    sentTimes = sentTimes.filter((time) => Date.now() - time < 60 * 60 * 1000);
    if (!item.force && sentTimes.length >= maxPerHour) return;
    const destinations = await resolveDestinations();
    if (!destinations.length) throw new Error('Escolha pelo menos um grupo na seção WhatsApp do painel.');
    for (const destination of destinations) {
      let sent = false;
      let lastSendError;
      for (let attempt = 0; attempt < 2 && !sent; attempt += 1) {
        try {
          await refreshActivePage();
          await client.sendMessage(destination.id, item.message);
          sent = true;
        } catch (error) {
          lastSendError = error;
          if (!String(error.message).includes('detached Frame') || attempt === 1) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!sent) throw lastSendError || new Error(`O WhatsApp não confirmou o envio para ${destination.name || 'um dos grupos'}.`);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    sentTimes.push(Date.now());
    await request(`/api/worker/queue/${item.id}/complete`, { method: 'POST', body: '{}' });
    console.log(`Enviado para ${destinations.length} grupo(s): ${item.offerTitle}`);
  } catch (error) {
    console.error(error.message);
    if (item) await request(`/api/worker/queue/${item.id}/fail`, { method: 'POST', body: JSON.stringify({ error: error.message }) }).catch(() => {});
  } finally { processing = false; }
}

client.on('qr', async (code) => {
  console.log('QR Code atualizado no painel.');
  if (process.env.NODE_ENV !== 'production') qrcode.generate(code, { small: true });
  await request('/api/worker/qr', { method: 'POST', body: JSON.stringify({ qr: code }) }).catch(() => {});
});
client.on('code', async (code) => {
  console.log('Código de conexão gerado.');
  await request('/api/worker/pairing-code', { method: 'POST', body: JSON.stringify({ code }) }).catch(() => {});
});
client.on('authenticated', async () => {
  console.log('WhatsApp autenticado.');
  await request('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ status: 'authenticated', message: 'Número vinculado. Carregando seus grupos…' })
  }).catch(() => {});
  setTimeout(startConnectedServices, 3_000);
});
client.on('ready', async () => {
  await startConnectedServices();
});
client.on('auth_failure', async (message) => { console.error('Falha de autenticação:', message); await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'error', message }) }).catch(() => {}); });
client.on('disconnected', async (reason) => { console.error('WhatsApp desconectado:', reason); await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'offline', message: String(reason) }) }).catch(() => {}); });

await refreshConfig();
await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'starting', message: 'Abrindo o WhatsApp Web…' }) }).catch(() => {});
clearStaleBrowserLocks();
client.initialize().catch(async (error) => {
  const message = error.message?.includes('ERR_NETWORK_ACCESS_DENIED')
    ? 'O Windows bloqueou o acesso ao WhatsApp Web. Reinicie o site fora do modo restrito.'
    : `Não foi possível abrir o WhatsApp Web: ${error.message}`;
  console.error(message);
  await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'error', message }) }).catch(() => {});
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
