import 'dotenv/config';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecrets } from '../server/secrets.js';
import { readStore } from '../server/store.js';
import { downloadWhatsappImage } from '../server/whatsappMedia.js';
import {
  buildMentionAllPayload,
  uniqueParticipantIds
} from './whatsappMentions.js';
import {
  shouldMentionEveryone,
  uniqueWhatsAppDestinations
} from './whatsappDestinations.js';

const { Client, LocalAuth, MessageMedia } = pkg;

// whatsapp-web.js pode chamar inject() novamente durante uma navegação da
// página enquanto a injeção anterior ainda está registrando os bindings. Isso
// faz o Puppeteer tentar expor onQRChangedEvent duas vezes e encerra o worker.
// Serializamos as injeções por cliente, mantendo o comportamento da biblioteca
// e evitando a corrida sem alterar os arquivos em node_modules.
const originalInject = Client.prototype.inject;
if (typeof originalInject === 'function' && !originalInject.__promoshopSerialized) {
  const injectQueue = new WeakMap();
  const serializedInject = function serializedInject(...args) {
    const previous = injectQueue.get(this) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => originalInject.apply(this, args));
    injectQueue.set(this, current);
    const clear = () => {
      if (injectQueue.get(this) === current) injectQueue.delete(this);
    };
    current.then(clear, clear);
    return current;
  };
  serializedInject.__promoshopSerialized = true;
  Client.prototype.inject = serializedInject;
}

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

function clearRegenerableBrowserCaches() {
  const sessionPath = path.join(authDataPath, 'session-promoshop');
  const cachePaths = [
    'Default/Cache',
    'Default/Code Cache',
    'Default/GPUCache',
    'Default/Service Worker/CacheStorage',
    'GrShaderCache',
    'ShaderCache'
  ];
  for (const relativePath of cachePaths) {
    try {
      rmSync(path.join(sessionPath, relativePath), { recursive: true, force: true });
    } catch (error) {
      console.warn(`Não foi possível limpar o cache regenerável ${relativePath}: ${error.message}`);
    }
  }
}
const pairingPhoneNumber = String(process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');
const storedSecrets = await readSecrets();
const workerToken = process.env.WORKER_TOKEN || storedSecrets.workerToken;
let groupId = '';
let groupName = '';
let selectedGroups = [];
let maxPerHour = 10;
let communityEnabled = true;
let communityName = 'PromoShop - Ofertas';
let mentionAllEnabled = false;
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
  '--disable-breakpad',
  '--disk-cache-size=33554432',
  '--media-cache-size=16777216',
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

// O Render não possui servidor gráfico. Mesmo que uma configuração antiga
// tenha deixado o modo oculto desligado, o publicador precisa iniciar sem
// abrir janela nesse ambiente. Em um computador com tela, a opção do painel
// continua podendo escolher o modo visível.
const hasDisplay =
  process.platform === 'win32' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const headless =
  initialStore.config.whatsappHeadless !== false ||
  !hasDisplay;

if (!workerToken) {
  console.error('Não foi possível carregar a identificação segura do publicador.');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'promoshop', dataPath: authDataPath }),
  ...(pairingPhoneNumber ? { pairWithPhoneNumber: { phoneNumber: pairingPhoneNumber, showNotification: true, intervalMs: 180000 } } : {}),
  puppeteer: {
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: chromiumArgs
  }
});

let sentTimes = [];
let processing = false;
let connectedServicesStarted = false;
let whatsappReady = false;
let shuttingDown = false;
let shutdownPromise = null;
const groupParticipantCache = new Map();
const GROUP_PARTICIPANT_CACHE_MS = 5 * 60 * 1000;

function shutdownWhatsappWorker(reason = 'encerramento solicitado', exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  whatsappReady = false;
  shutdownPromise = (async () => {
    console.log(`Encerrando publicador do WhatsApp: ${reason}.`);
    const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([
      Promise.resolve().then(() => client.destroy()).catch((error) => {
        console.warn(`Não foi possível fechar o Chromium normalmente: ${error.message}`);
      }),
      timeout
    ]);
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => { void shutdownWhatsappWorker('sinal de reinicialização'); });
process.once('SIGINT', () => { void shutdownWhatsappWorker('interrupção manual'); });

async function request(path, options = {}) {
  const timeoutMs = path.includes('/heartbeat') ? 8_000 : 20_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...options,
      signal,
      headers: { 'Content-Type': 'application/json', 'x-worker-token': workerToken, ...(options.headers || {}) }
    });
  } catch (error) {
    if (timeoutSignal.aborted) throw new Error(`A API não respondeu em ${Math.round(timeoutMs / 1000)} segundos.`);
    throw error;
  }
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`API respondeu ${response.status}`);
  return response.json();
}

async function claimDestination(item, destination) {
  const result = await request(`/api/worker/queue/${item.id}/destination/claim`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destination.id, destinationName: destination.name })
  });
  return result?.claimed === true;
}

async function completeDestination(item, destination) {
  await request(`/api/worker/queue/${item.id}/destination/complete`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destination.id, destinationName: destination.name })
  });
}

async function startDestination(item, destination) {
  await request(`/api/worker/queue/${item.id}/destination/started`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destination.id })
  });
}

async function releaseDestination(item, destination) {
  await request(`/api/worker/queue/${item.id}/destination/release`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destination.id })
  });
}

async function completeQueueItem(item) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await request(`/api/worker/queue/${item.id}/complete`, { method: 'POST', body: '{}' });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError || new Error('Não foi possível confirmar a publicação.');
}

async function refreshConfig() {
  const config = await request('/api/worker/config');
  groupId = config.groupId || '';
  groupName = config.groupName || '';
  selectedGroups = Array.isArray(config.selectedGroups) ? config.selectedGroups.filter((group) => group.id) : [];
  if (!selectedGroups.length && groupId) selectedGroups = [{ id: groupId, name: groupName }];
  maxPerHour = Number(config.maxPerHour || 10);
  communityEnabled = config.communityEnabled !== false;
  communityName = String(config.communityName || 'PromoShop - Ofertas').trim();
  mentionAllEnabled = config.mentionAllEnabled === true;
}

function normalizeGroupName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWhatsAppGroup(id) {
  return String(id || '').endsWith('@g.us');
}

function isWhatsAppChannel(id) {
  return String(id || '').endsWith('@newsletter');
}

function isWhatsAppDestination(id) {
  return isWhatsAppGroup(id) || isWhatsAppChannel(id);
}

async function loadGroupParticipantIds(groupId) {
  const cached = groupParticipantCache.get(groupId);
  if (cached && Date.now() - cached.loadedAt < GROUP_PARTICIPANT_CACHE_MS) {
    return cached.ids;
  }

  await refreshActivePage();
  const chat = await client.getChatById(groupId);
  if (!chat?.participants) {
    throw new Error('O WhatsApp não retornou os participantes do grupo.');
  }
  const ids = uniqueParticipantIds(chat?.participants || []);
  groupParticipantCache.set(groupId, { ids, loadedAt: Date.now() });
  return ids;
}

async function buildDelivery(destination, message, item) {
  const mentionEveryone = shouldMentionEveryone({
    enabled: mentionAllEnabled,
    item,
    destination
  });
  const baseOptions = {
    // Canais não possuem conversa a ser marcada como lida antes do envio.
    sendSeen: !isWhatsAppChannel(destination.id)
  };

  if (!mentionEveryone) {
    return { message, options: baseOptions };
  }

  try {
    const participantIds = await loadGroupParticipantIds(destination.id);
    const payload = buildMentionAllPayload(message, participantIds);

    console.log(
      `Marcação @todos preparada para "${destination.name || destination.id}" ` +
      `(${payload.participantCount} participante(s)).`
    );

    return {
      message: payload.message,
      options: { ...baseOptions, ...payload.options }
    };
  } catch (error) {
    // O marcador nativo ainda é enviado mesmo se a lista de participantes
    // não puder ser carregada. Assim, versões atuais do WhatsApp Web continuam
    // conseguindo marcar o grupo sem bloquear a fila de publicação.
    console.warn(
      `Não foi possível carregar os participantes de "${destination.name || destination.id}": ${error.message}`
    );

    const payload = buildMentionAllPayload(message);
    return {
      message: payload.message,
      options: { ...baseOptions, ...payload.options }
    };
  }
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

  return page.evaluate(async () => {
    const collection =
      window.require?.('WAWebCollections')?.Chat ||
      window.Store?.Chat;

    const chats = [
      ...(collection?.getModelsArray?.() || collection?.models || [])
    ];

    const newsletterCollection =
      window.require?.('WAWebCollections')?.WAWebNewsletterCollection;

    let channels = [];
    try {
      channels = window.WWebJS?.getChannels
        ? await window.WWebJS.getChannels()
        : (newsletterCollection?.getModelsArray?.() || newsletterCollection?.models || []);
    } catch {
      channels = newsletterCollection?.getModelsArray?.() || newsletterCollection?.models || [];
    }

    const seen = new Set();

    return [...chats, ...channels]
      .map((chat) => {
        const id =
          typeof chat.id === 'string'
            ? chat.id
            : chat.id?._serialized ||
              (
                chat.id?.user && chat.id?.server
                  ? `${chat.id.user}@${chat.id.server}`
                  : ''
              );

        const isChannel = Boolean(chat.isChannel) || id.endsWith('@newsletter');

        if (!id || (!id.endsWith('@g.us') && !isChannel) || seen.has(id)) {
          return null;
        }

        seen.add(id);

        const metadata =
          chat.groupMetadata ||
          chat.groupMetadata?.groupMetadata ||
          null;

        const channelMetadata =
          chat.channelMetadata ||
          chat.newsletterMetadata ||
          null;

        const name =
          chat.name ||
          chat.formattedTitle ||
          chat.title ||
          metadata?.subject ||
          metadata?.name ||
          channelMetadata?.name ||
          channelMetadata?.title ||
          chat.contact?.pushname ||
          chat.contact?.name ||
          chat.contact?.shortName ||
          '';

        return {
          id,
          name: String(name || '').trim(),
          type: isChannel ? 'channel' : 'group'
        };
      })
      .filter(Boolean);
  });
}

async function syncGroups(attempt = 1) {
  try {
    const groups = (await listGroups()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    console.log('Grupos encontrados pelo WhatsApp:');

    for (const group of groups) {
      console.log(`- ${group.name || '[SEM NOME]'} | ${group.type}`);
    }
    await request('/api/worker/groups', { method: 'POST', body: JSON.stringify({ groups }) });
    const message = selectedGroups.length
      ? `Conectado. ${selectedGroups.length} destino${selectedGroups.length === 1 ? '' : 's'} selecionado${selectedGroups.length === 1 ? '' : 's'} para publicação.`
      : `${groups.length} grupos e canais encontrados. Escolha os destinos no painel.`;
    await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'connected', message }) });
    console.log(`WhatsApp conectado. ${groups.length} grupos/canais disponíveis.`);
  } catch (error) {
    console.error(
      `Tentativa ${attempt} de carregar grupos falhou:`,
      error?.message || String(error),
      error?.stack || ''
    );
    await request('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        status: whatsappReady ? 'connected' : 'offline',
        message: whatsappReady
          ? 'WhatsApp conectado, mas não foi possível atualizar a lista de grupos.'
          : 'WhatsApp desconectado. Não foi possível carregar os grupos.'
      })
    }).catch(() => { });
    if (attempt < 12) setTimeout(() => syncGroups(attempt + 1), 10_000);
  }
}

async function startConnectedServices() {
  if (connectedServicesStarted) return;
  connectedServicesStarted = true;
  await request('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ status: 'connected', message: 'WhatsApp conectado. Carregando a lista de grupos…' })
  }).catch(() => { });
  await refreshConfig().catch((error) => console.error('Não foi possível carregar as configurações:', error.message));
  await syncGroups();
  processQueue();
  setInterval(() => {
    processQueue();
  }, 10_000);
  setInterval(() => {
    if (!whatsappReady) {
      return;
    }

    request('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        status: 'connected',
        message: 'WhatsApp conectado e publicador ativo.'
      })
    }).catch((error) => {
      console.error(
        'Falha ao atualizar o estado da conexão:',
        error.message
      );
    });
  }, 15_000);
}

async function resolveDestinations(item) {
  let audienceCodes = [];

  /*
   * Quando o servidor estiver executando
   * uma rodada por público, ele informa
   * exatamente qual grupo deve receber
   * esta publicação.
   */
  if (item?.roundAudienceCode) {
    audienceCodes = [
      String(item.roundAudienceCode)
        .trim()
        .toUpperCase()
    ];
  } else {
    audienceCodes =
      Array.isArray(item?.targetAudienceCodes)
        ? item.targetAudienceCodes
          .map((code) =>
            String(code || '')
              .trim()
              .toUpperCase()
          )
          .filter(Boolean)
        : [];
  }

  const groups = await listGroups();
  const selectedIds = new Set(selectedGroups.map((group) => String(group.id)));
  const selectedDestinations = selectedIds.size
    ? groups.filter((group) => selectedIds.has(String(group.id)))
    : groups;

  const destinations =
    selectedDestinations.filter((group) => {
      // Canais não participam da classificação Gxx. Eles são incluídos
      // abaixo pelo nome da comunidade/canal geral.
      if (!isWhatsAppGroup(group.id)) return false;

      const name =
        String(group.name || '')
          .trim();

      return audienceCodes.some(
        (code) => {
          const escapedCode =
            code.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&'
            );

          return new RegExp(
            `(?:\\||\\s)${escapedCode}\\s*$`,
            'i'
          ).test(name);
        }
      );
    });

  // A comunidade geral não usa o padrão Gxx no nome. Ela recebe a oferta
  // além do grupo temático, quando estiver habilitada e selecionada no painel.
  const normalizedCommunity = normalizeGroupName(communityName);
  if (communityEnabled && normalizedCommunity && item?.skipCommunityDestination !== true) {
    // O mesmo nome pode existir como comunidade/grupo e como canal. Procure
    // em todos os destinos sincronizados, mesmo que o usuário tenha marcado
    // apenas os grupos temáticos.
    const communityDestinations = groups.filter((group) => {
      if (!isWhatsAppDestination(group.id)) return false;
      const normalizedGroup = normalizeGroupName(group.name);
      // Igualdade intencional: "PromoShop - Ofertas Gerais | G01" não pode
      // ser confundido com a comunidade "PromoShop - Ofertas".
      return normalizedGroup === normalizedCommunity;
    });

    for (const communityDestination of communityDestinations) {
      if (!destinations.some((destination) => destination.id === communityDestination.id)) {
        destinations.push(communityDestination);
      }
    }
  }

  if (!audienceCodes.length && !destinations.length) {
    console.warn(
      `Oferta "${item?.offerTitle || 'sem título'}" não possui público definido. Envio cancelado.`
    );
    return [];
  }

  if (!destinations.length) {
    console.warn(
      `Nenhum grupo encontrado para: ${audienceCodes.join(', ')}`
    );

    return [];
  }

  // Comunidade, grupo geral e canal podem usar exatamente o mesmo nome, mas
  // têm IDs diferentes. Deduplicar pelo nome descartava esses destinos antes
  // do envio; o ID é a identidade correta no WhatsApp.
  const unique = uniqueWhatsAppDestinations(destinations);
  if (unique.length !== destinations.length) {
    console.warn(
      `Destinos duplicados ignorados: ${destinations.length - unique.length}.`
    );
  }

  const attempted = new Set(
    [
      ...(Array.isArray(item?.deliveryClaimedDestinationIds) ? item.deliveryClaimedDestinationIds : []),
      ...(Array.isArray(item?.deliveryAttemptedDestinationIds) ? item.deliveryAttemptedDestinationIds : []),
      ...(Array.isArray(item?.deliverySentDestinationIds) ? item.deliverySentDestinationIds : [])
    ]
      .map((id) => String(id))
  );
  return unique.filter((destination) => !attempted.has(String(destination.id)));
}

async function processQueue() {
  if (processing) return;
  processing = true;
  let item = null;
  try {
    if (!whatsappReady) {
      return;
    }
    await refreshConfig();
    item = await request('/api/worker/queue/next');
    if (!item) return;
    sentTimes = sentTimes.filter((time) => Date.now() - time < 60 * 60 * 1000);
    if (!item.force && sentTimes.length >= maxPerHour) return;
    const destinations = await resolveDestinations(item);
    console.log(
      `Roteamento de "${item.offerTitle}": ${Array.isArray(item.targetAudienceCodes)
        ? item.targetAudienceCodes.join(', ')
        : 'modo antigo'
      } → ${destinations.map((group) => group.name).join(' | ')
      }`
    );
    if (!destinations.length) {
      if (Array.isArray(item.deliveryAttemptedDestinationIds) && item.deliveryAttemptedDestinationIds.length) {
        throw new Error('O envio desta oferta já foi iniciado e os destinos já tentados foram protegidos contra repetição.');
      }
      throw new Error('Escolha pelo menos um grupo na seção WhatsApp do painel.');
    }
    let deliveredDestinations = 0;
    const destinationErrors = [];
    let safeRetryAvailable = false;
    for (const destination of destinations) {
      const claimed = await claimDestination(item, destination);
      if (!claimed) {
        console.warn(`Destino já protegido contra repetição: ${destination.name || destination.id}`);
        continue;
      }
      let deliveryStarted = false;
      try {
      const delivery = await buildDelivery(destination, item.message, item);
      let sent = false;
      let lastSendError;
      // O destino já foi reservado no servidor. Não repetimos a chamada em
      // caso de erro ambíguo (por exemplo, uma mensagem aceita pelo WhatsApp
      // mas com resposta de rede perdida).
      for (let attempt = 0; attempt < 1 && !sent; attempt += 1) {
        try {
          await refreshActivePage();

          if (item.image) {
            let prepared;
            try {
              console.log(`Baixando imagem da oferta: ${item.image}`);
              prepared = await downloadWhatsappImage(item.image);
            } catch (mediaError) {
              console.error(
                `Falha ao baixar a imagem de "${item.offerTitle}": ${mediaError.message}`
              );

              if (isWhatsAppChannel(destination.id)) {
                throw new Error(`Não foi possível publicar a imagem no canal: ${mediaError.message}`);
              }

              console.log('Enviando somente o texto como alternativa no grupo.');
              await startDestination(item, destination);
              deliveryStarted = true;
              await client.sendMessage(destination.id, delivery.message, {
                ...delivery.options,
                waitUntilMsgSent: true
              });
              sent = true;
            }

            if (!sent) {
              const media = new MessageMedia(prepared.mimetype, prepared.data.toString('base64'), prepared.filename, prepared.filesize);
              console.log(`Imagem carregada: ${media.mimetype || 'tipo desconhecido'}`);
              await startDestination(item, destination);
              deliveryStarted = true;
              const sentMedia = await client.sendMessage(destination.id, media, {
                ...delivery.options,
                caption: delivery.message,
                waitUntilMsgSent: true
              });
              // `waitUntilMsgSent` já aguarda a conclusão da ação de envio. Em
              // algumas versões do WhatsApp Web, a mensagem aceita ainda não
              // aparece na coleção local e a biblioteca devolve `undefined`.
              // Isso não é uma falha de entrega e não pode interromper os
              // próximos destinos (comunidade/canal). O claim persistido no
              // servidor continua impedindo qualquer reenvio duplicado.
              if (!sentMedia) {
                console.warn(`Envio aceito sem confirmação local imediata: ${item.offerTitle}`);
              } else {
                console.log(`Imagem e mensagem enviadas: ${item.offerTitle}`);
              }
            }
          } else {
            console.warn(
              `Oferta sem imagem: "${item.offerTitle}"`
            );

            await startDestination(item, destination);
            deliveryStarted = true;
            await client.sendMessage(destination.id, delivery.message, delivery.options);
          }

          sent = true;
        } catch (error) {
          lastSendError = error;
          throw error;
        }
      }
      if (!sent) throw lastSendError || new Error(`O WhatsApp não confirmou o envio para ${destination.name || 'um dos grupos'}.`);
      await completeDestination(item, destination);
      deliveredDestinations += 1;
      const store =
        await readStore();

      const audienceDelaySeconds =
        Math.max(
          5,
          Number(
            store.config
              .whatsappAudienceDelaySeconds ||
            15
          )
        );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            audienceDelaySeconds * 1000
          )
      );
      } catch (error) {
        if (!deliveryStarted) {
          safeRetryAvailable = true;
          await releaseDestination(item, destination).catch(() => {});
        }
        destinationErrors.push({
          destination: destination.name || destination.id,
          message: String(error?.message || error || 'Falha desconhecida'),
          deliveryStarted
        });
        console.error(
          `Falha no destino "${destination.name || destination.id}"; os demais destinos continuarão: ${error?.message || error}`
        );
      }
    }
    if (destinationErrors.length) {
      if (deliveredDestinations > 0) sentTimes.push(Date.now());
      const detail = destinationErrors
        .map((entry) => `${entry.destination}: ${entry.message}`)
        .join(' | ')
        .slice(0, 500);
      await request(`/api/worker/queue/${item.id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: detail, retrySafe: safeRetryAvailable })
      });
      console.warn(
        `${deliveredDestinations} destino(s) concluído(s) e ${destinationErrors.length} com falha para "${item.offerTitle}".`
      );
      return;
    }
    if (!deliveredDestinations) {
      throw new Error('Nenhum destino novo pôde ser reservado; a oferta foi protegida contra repetição.');
    }
    sentTimes.push(Date.now());
    await completeQueueItem(item);
    console.log(`Enviado para ${destinations.length} grupo(s): ${item.offerTitle}`);
  } catch (error) {
    console.error(error.message);
    if (item) await request(`/api/worker/queue/${item.id}/fail`, { method: 'POST', body: JSON.stringify({ error: error.message }) }).catch(() => { });
  } finally { processing = false; }
}

client.on('qr', async (code) => {
  console.log('QR Code atualizado no painel.');
  if (process.env.NODE_ENV !== 'production') qrcode.generate(code, { small: true });
  await request('/api/worker/qr', { method: 'POST', body: JSON.stringify({ qr: code }) }).catch(() => { });
});
client.on('code', async (code) => {
  console.log('Código de conexão gerado.');
  await request('/api/worker/pairing-code', { method: 'POST', body: JSON.stringify({ code }) }).catch(() => { });
});
client.on('authenticated', async () => {
  console.log('WhatsApp autenticado. Aguardando o cliente ficar pronto para publicar.');

  await request('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      status: 'authenticated',
      message: 'Número vinculado. Aguardando o WhatsApp ficar pronto…'
    })
  }).catch(() => { });
});
client.on('ready', async () => {
  console.log('WhatsApp pronto. Iniciando o publicador.');

  whatsappReady = true;

  await startConnectedServices();
});
client.on('auth_failure', async (message) => {
  whatsappReady = false;

  console.error('Falha de autenticação:', message);

  await request('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      status: 'error',
      message
    })
  }).catch(() => { });
});
client.on('disconnected', async (reason) => {
  whatsappReady = false;

  console.error('WhatsApp desconectado:', reason);

  await request('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      status: 'offline',
      message: `WhatsApp desconectado: ${String(reason)}`
    })
  }).catch(() => { });

  if (
    String(reason).toUpperCase() === 'LOGOUT' &&
    !shuttingDown
  ) {
    console.log(
      'Logout detectado. Encerrando o worker para reinicialização limpa.'
    );
    void shutdownWhatsappWorker('logout detectado');
  }
});
await refreshConfig();
await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'starting', message: 'Abrindo o WhatsApp Web…' }) }).catch(() => { });
clearStaleBrowserLocks();
clearRegenerableBrowserCaches();
client.initialize().catch(async (error) => {
  const message = error.message?.includes('ERR_NETWORK_ACCESS_DENIED')
    ? 'O Windows bloqueou o acesso ao WhatsApp Web. Reinicie o site fora do modo restrito.'
    : `Não foi possível abrir o WhatsApp Web: ${error.message}`;
  console.error(message);
  await request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ status: 'error', message }) }).catch(() => { });
  void shutdownWhatsappWorker('falha ao iniciar o WhatsApp Web', 1);
});
