import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  DEFAULT_WHATSAPP_AUDIENCES
} from './audienceRouting.js';
import { DEFAULT_INSTAGRAM_THEMES, sanitizeInstagramThemes } from './instagramThemes.js';
import { DEFAULT_INSTAGRAM_HIGHLIGHTS, sanitizeInstagramHighlights } from './instagramHighlights.js';
import { createPostgresStateBackend } from './postgresStore.js';
import { recordSentSourceInLedger } from './whatsappDedup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const dataFile = path.join(dataDir, 'db.json');
const dataKeyFile = path.join(dataDir, '.data-key');
let dataMigrationPromise = null;
let cachedEnvironmentDataKey = null;
let cachedFileDataKey = null;

function environmentDataKey() {
  if (cachedEnvironmentDataKey) return cachedEnvironmentDataKey;
  const configured = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (/^[a-f0-9]{64}$/i.test(configured)) {
    cachedEnvironmentDataKey = Buffer.from(configured, 'hex');
    return cachedEnvironmentDataKey;
  }
  if (configured) {
    try {
      const decoded = Buffer.from(configured, 'base64');
      if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === configured.replace(/=+$/, '')) {
        cachedEnvironmentDataKey = decoded;
        return cachedEnvironmentDataKey;
      }
    } catch {}
    if (configured.length >= 32) {
      cachedEnvironmentDataKey = crypto.createHash('sha256').update(configured, 'utf8').digest();
      return cachedEnvironmentDataKey;
    }
    throw new Error('DATA_ENCRYPTION_KEY precisa ter pelo menos 32 caracteres.');
  }
  return null;
}

async function fileDataKey({ create = true } = {}) {
  if (cachedFileDataKey) return cachedFileDataKey;
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const saved = (await fs.readFile(dataKeyFile, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(saved)) {
      cachedFileDataKey = Buffer.from(saved, 'hex');
      return cachedFileDataKey;
    }
    throw new Error('A chave local dos dados pessoais está corrompida.');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
  }
  const key = crypto.randomBytes(32);
  await fs.writeFile(dataKeyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  cachedFileDataKey = key;
  return cachedFileDataKey;
}

async function getDataKey() {
  return environmentDataKey() || fileDataKey();
}

async function retireLocalDataKey() {
  if (!environmentDataKey()) return;
  await fs.unlink(dataKeyFile).catch((error) => {
    if (error?.code !== 'ENOENT') console.warn('A chave local antiga dos dados pessoais não pôde ser removida.');
  });
  cachedFileDataKey = null;
}

async function encryptSensitive(value) {
  const key = await getDataKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    __encrypted: 'aes-256-gcm-v1',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

async function decryptSensitive(value) {
  if (!value || value.__encrypted !== 'aes-256-gcm-v1') return { value, encrypted: false };
  const decryptWithKey = (key) => {
    const iv = Buffer.from(value.iv, 'base64');
    const tag = Buffer.from(value.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Dados criptografados inválidos.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  };
  const configuredKey = environmentDataKey();
  if (configuredKey) {
    try {
      return { value: decryptWithKey(configuredKey), encrypted: true, legacyKey: false };
    } catch (environmentError) {
      try {
        return { value: decryptWithKey(await fileDataKey({ create: false })), encrypted: true, legacyKey: true };
      } catch {
        throw new Error(`Não foi possível descriptografar os dados pessoais com a chave configurada: ${environmentError.message}`);
      }
    }
  }
  return { value: decryptWithKey(await fileDataKey()), encrypted: true, legacyKey: false };
}

async function restoreSensitiveData(data) {
  let encrypted = true;
  let legacyKey = false;
  for (const key of ['inbox', 'privacyConsents']) {
    const restored = await decryptSensitive(data[key]);
    data[key] = restored.value;
    encrypted &&= restored.encrypted;
    legacyKey ||= restored.legacyKey === true;
  }
  if (data.analytics && typeof data.analytics === 'object') {
    const restored = await decryptSensitive(data.analytics.visitors);
    data.analytics.visitors = restored.value;
    encrypted &&= restored.encrypted;
    legacyKey ||= restored.legacyKey === true;
  }
  return { data, encrypted, requiresReencrypt: legacyKey };
}

async function protectSensitiveData(data) {
  const persisted = {
    ...data,
    analytics: { ...(data.analytics || {}) }
  };
  persisted.inbox = await encryptSensitive(persisted.inbox || []);
  persisted.privacyConsents = await encryptSensitive(persisted.privacyConsents || {});
  persisted.analytics.visitors = await encryptSensitive(persisted.analytics.visitors || {});
  return persisted;
}

async function writeProtectedSnapshot(data) {
  const temporaryFile = path.join(dataDir, `db-migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(temporaryFile, JSON.stringify(await protectSensitiveData(data)), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryFile, dataFile);
}

const initialData = {
  config: {
    brandName: 'PromoShop',
    heroTitle: 'Ofertas boas não esperam.',
    heroText: 'Promoções selecionadas e organizadas para você economizar sem perder tempo.',
    primaryColor: '#1269f3',
    whatsappUrl: '#',
    instagramUrl: '',
    whatsappAudiences: DEFAULT_WHATSAPP_AUDIENCES,
    disclosure: 'Podemos receber comissão pelas compras, sem custo adicional para você.',
    contactEmail: 'contatopromoshop.site@gmail.com',
    canonicalUrl: 'https://promoshop.jhonatafaraujo.com.br',
    seoSiteName: 'PromoShop - Ofertas Diárias',
    seoTitle: 'PromoShop - Ofertas Diárias',
    seoDescription: 'Encontre ofertas diárias e cupons selecionados do Mercado Livre, Shopee, AliExpress e Magalu. Confirme as condições diretamente na loja.',
    seoKeywords: 'ofertas, promoções, cupons, Mercado Livre, Shopee, AliExpress, Magalu',
    seoImageUrl: '',
    seoIndexingEnabled: true,
    seoStructuredDataEnabled: true,
    publicOfferPageSize: 24,
    publicOfferMaxAgeDays: 45,
    smartRankingEnabled: true,
    rankingDiscountWeight: 35,
    rankingFreshnessWeight: 25,
    rankingQualityWeight: 25,
    rankingClicksWeight: 15,
    duplicateGroupingEnabled: true,
    rankingDiversityEnabled: true,
    publicAdvancedFiltersEnabled: true,
    favoritesEnabled: true,
    assistantEnabled: true,
    searchConsoleSiteUrl: 'sc-domain:jhonatafaraujo.com.br',
    searchConsoleRedirectUri: 'https://promoshop.jhonatafaraujo.com.br/api/search-console/callback',
    showOfferUpdatedAt: true,
    affiliateDisclosureLabel: 'Publicidade · Link de afiliado',
    mobileCompactMenu: true,
    clickAnalyticsEnabled: true,
    analyticsVisitorRetentionDays: 365,
    analyticsDailyRetentionDays: 120,
    contactRetentionMonths: 12,
    consentReceiptRetentionYears: 5,
    qualityFilterEnabled: true,
    qualityMinimumScore: 55,
    qualityRequireImage: true,
    qualityRequireHttpsLink: true,
    qualityMaxTitleLength: 180,
    qualityBlockedTerms: 'réplica, falsificado, pirataria, produto surpresa',
    staleOffersHidden: true,
    linkCheckEnabled: true,
    linkCheckAutoPause: false,
    linkCheckBatchSize: 20,
    monitoringEnabled: true,
    monitoringEmail: 'contatopromoshop.site@gmail.com',
    monitoringWhatsappMinutes: 5,
    monitoringCollectionHours: 6,
    monitoringFailedQueueLimit: 10,
    legalResponsibleName: 'Jhonata Ferreira de Araujo',
    legalResponsibleType: 'pessoa física',
    legalCityState: 'Brasília/DF',
    legalPrivacyEmail: 'contatopromoshop.site@gmail.com',
    legalResponseBusinessDays: 5,
    legalContactRetentionMonths: 12,
    legalConsentRetentionYears: 5,
    legalAffiliatePrograms: 'Mercado Livre, Shopee, AliExpress e Magalu',
    legalPolicyVersion: '2026-08-23-v5',
    legalAboutCustomText: '',
    legalContactCustomText: '',
    legalTermsCustomText: '',
    legalPrivacyCustomText: '',
    inboxInboundEnabled: false,
    inboxInboundDomain: 'reply.jhonatafaraujo.com.br',
    inboxInboundWebhookId: '',
    inboxInboundWebhookUrl: '',
    minDiscount: 20,

    maxPostsPerDay: 100,
    maxPostsPerAudiencePerDay: 10,

    quietStart: '22:00',
    quietEnd: '08:00',

    publishingStart: '08:00',
    publishingEnd: '23:00',

    collectionIntervalMinutes: 15,

    mercadoLivreQueries:
      'smartphone, fone bluetooth, notebook, casa e decoração',

    mercadoLivreRedirectUri:
      'https://promoshop.jhonatafaraujo.com.br/api/mercadolivre/callback',

    shopeeQueries:
      'eletrônicos, casa, beleza, moda, ferramentas',

    aliexpressQueries:
      'eletrônicos, ferramentas, casa, acessórios',

    aliexpressTrackingId: 'promoshop',

    whatsappGroupId: '',
    whatsappGroupName: '',
    whatsappGroups: [],

    // Destino geral opcional. O nome é comparado sem acentos, emojis e pontuação
    // para reconhecer variações como "PromoShop - Ofertas ⚡".
    whatsappCommunityEnabled: true,
    whatsappCommunityName: 'PromoShop - Ofertas',

    // A marcação coletiva é opcional para evitar excesso de notificações.
    whatsappMentionAllEnabled: false,

    whatsappMaxPerHour: 100,
    whatsappIntervalMinutes: 15,

    whatsappMinDelaySeconds: 12,
    whatsappMaxDelaySeconds: 30,

    whatsappAudienceRoundEnabled: true,

    whatsappOneOfferPerAudiencePerRound: true,

    whatsappAudienceDelaySeconds: 15,

    whatsappUniqueOfferPerRound: true,

    whatsappAudienceCooldownHours: 24,

    whatsappDirectoryTitle: '📢 Encontre seu grupo PromoShop',
    whatsappDirectoryIntro: 'Escolha os assuntos que você mais gosta e entre nos grupos:',
    whatsappDirectoryFooter: '✅ Entre nos seus favoritos e acompanhe as próximas ofertas.',
    whatsappDirectoryIncludedCodes: [],
    whatsappDirectoryTargetCodes: [],

    whatsappHeadless: true,
    whatsappAutoStart: true,

    instagramEnabled: false,
    instagramAutoFromWhatsapp: true,
    instagramIncludeCoupons: true,
    instagramFeedEnabled: false,
    instagramFeedAutoFromWhatsapp: false,
    instagramFeedPostType: 'single',
    instagramFeedFormat: 'portrait',
    instagramFeedTemplateMode: 'rotating',
    instagramFeedCarouselFrequency: 'daily',
    instagramFeedCarouselsPerDay: 1,
    instagramFeedCarouselsPerWeek: 3,
    instagramFeedPublishingStart: '09:00',
    instagramFeedPublishingEnd: '21:00',
    instagramFeedPublishingDays: [1, 3, 5],
    instagramFeedIntervalMinutes: 120,
    instagramFeedMaxPerDay: 3,
    instagramFeedMinimumDiscount: 20,
    instagramFeedDuplicateDays: 7,
    instagramFeedCarouselSize: 4,
    instagramFeedCaption: '🔥 Ofertas selecionadas do dia\n\n{offers}\n\n🔗 Acesse a bio do perfil\n\n#PromoShop #Ofertas #Promoção',
    instagramApiVersion: 'v25.0',
    instagramRedirectUri: 'https://promoshop.jhonatafaraujo.com.br/api/instagram/callback',
    instagramPublishingStart: '08:00',
    instagramPublishingEnd: '22:30',
    instagramIntervalMinutes: 20,
    instagramMaxPerDay: 15,
    instagramMinimumDiscount: 20,
    instagramDuplicateDays: 7,
    instagramStores: ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'],
    instagramAudienceCodes: [],
    instagramThemeMode: 'automatic',
    instagramManualThemeId: 'default',
    instagramThemes: DEFAULT_INSTAGRAM_THEMES.map((theme) => ({ ...theme })),
    instagramHighlights: DEFAULT_INSTAGRAM_HIGHLIGHTS.map((item) => ({ ...item })),
    instagramCtaText: 'Acesse o link da bio',
    instagramDisclosureText: 'Publicidade · link de afiliado',
    instagramShowQrCode: false,
    instagramAssetRetentionHours: 72,

    aiEnabled: true,

    aiProvider: 'gemini',

    aiModel: 'gemini-3.5-flash-lite',

    aiBaseUrl:
      'https://api.groq.com/openai/v1',

    aiOllamaUrl:
      'http://127.0.0.1:11434',

    aiFallbackEnabled: true,

    aiProviderOrder: [
      'gemini',
      'openai',
      'groq'
    ],

    aiModels: {
      gemini: 'gemini-3.5-flash-lite',
      openai: '',
      groq: 'openai/gpt-oss-20b'
    },

    aiTone: 'varied',

    aiInstructions:
      'Destaque o principal benefício do produto, seja convincente sem exagerar e use uma chamada para ação curta.',

    aiAudienceRoutingEnabled: true,

    aiAudienceRoutingMaxGroups: 1,

    aiAudienceRoutingRequireMatch: true,

    aiGeneralAudienceCode: 'G01',

    aiDealsAudienceCode: 'G10',

    enableMercadoLivre: true,
    enableShopee: false,
    enableAliexpress: false,
    enableMagalu: false,
    enableNetshoes: false,

    extensionEnabled: true,
    extensionAutoApprove: false,
    extensionStores: ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'],
    extensionAudienceCodes: ['G01'],
    extensionMaxCouponsPerRequest: 10,

    // Slug público da vitrine Magazine Você. A busca automática do Magalu
    // pode ser protegida por captcha; este endereço é usado para abrir a
    // busca da sua própria loja no painel.
    magaluStoreSlug: 'magazinepromoshopsite',

    autoQueue: false,
    messageTemplate: '🔥 *{title}*\n\n✨ {benefit}\n\nDe: ~{originalPrice}~\nPor: *{price}* 🔥\n💸 {discount}% OFF\n\n{shipping}\n\n👉 Confira a oferta:\n🛒 {link}\n\n⚠️ Preço, promoção e estoque podem mudar a qualquer momento.'
  },
  offers: [],
  coupons: [],
  inbox: [],
  privacyConsents: {},
  queue: [],
  instagramQueue: [],
  instagramFeedQueue: [],
  logs: [],
  analytics: {
    totalPageViews: 0,
    totalSessions: 0,
    totalVisitors: 0,
    totalClicks: 0,
    clicksByType: {},
    clicksByStore: {},
    clicksByTarget: {},
    visitors: {},
    daily: {}
  },
  meta: { lastCollectionAt: null, whatsapp: { status: 'offline', lastSeenAt: null, qrDataUrl: null, pairingCode: null, groups: [], message: 'Publicador ainda não iniciado.' } }
};

let writeChain = Promise.resolve();
let ensurePromise = null;
let cachedData = null;
let cachedSignature = '';
let bufferedLogs = [];
let bufferedLogTimer = null;
const configuredStoreBackend = String(process.env.STORE_BACKEND || 'file').trim().toLowerCase();
let postgresBackend = null;

if (!['file', 'postgres'].includes(configuredStoreBackend)) {
  throw new Error(`STORE_BACKEND inválido: "${configuredStoreBackend}". Use "file" ou "postgres".`);
}

function scheduleBufferedLogFlush(delay = 250) {
  if (bufferedLogTimer) return;
  bufferedLogTimer = setTimeout(async () => {
    bufferedLogTimer = null;
    const batch = bufferedLogs.splice(0);
    if (!batch.length) return;
    try {
      await updateStore((data) => {
        data.logs ||= [];
        data.logs.unshift(...[...batch].reverse());
        data.logs = data.logs.slice(0, 200);
      });
    } catch (error) {
      bufferedLogs.unshift(...batch);
      console.error('Falha ao salvar logs agrupados:', error.message);
      scheduleBufferedLogFlush(2000);
    }
  }, delay);
  bufferedLogTimer.unref?.();
}

async function ensureStore() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await fs.mkdir(dataDir, { recursive: true });
      try { await fs.access(dataFile); }
      catch { await fs.writeFile(dataFile, JSON.stringify(await protectSensitiveData(initialData)), { encoding: 'utf8', mode: 0o600 }); }
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

function storeSignature(stats) {
  return `${stats.size}:${stats.mtimeMs}`;
}

async function readFileStore() {
  await ensureStore();
  const stats = await fs.stat(dataFile);
  const signature = storeSignature(stats);
  if (cachedData && cachedSignature === signature) return cachedData;

  let data;
  let wasEncrypted = false;
  let requiresReencrypt = false;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const persisted = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      const restored = await restoreSensitiveData(persisted);
      data = restored.data;
      wasEncrypted = restored.encrypted;
      requiresReencrypt = restored.requiresReencrypt === true;
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  if (!data) throw lastError;
  if (!wasEncrypted) {
    if (!dataMigrationPromise) {
      dataMigrationPromise = writeProtectedSnapshot(data).finally(() => { dataMigrationPromise = null; });
    }
    await dataMigrationPromise;
  }
  if (requiresReencrypt) {
    await writeProtectedSnapshot(data);
    await retireLocalDataKey();
  }
  data = normalizeStoreData(data);
  cachedData = data;
  cachedSignature = signature;
  return data;
}

function normalizeStoreData(data) {
  data.config = {
    ...initialData.config,
    ...(data.config || {})
  };
  if (/^https:\/\/promoshop\.onrender\.com\/api\/mercadolivre\/callback\/?$/i.test(String(data.config.mercadoLivreRedirectUri || ''))) {
    data.config.mercadoLivreRedirectUri = initialData.config.mercadoLivreRedirectUri;
  }

  if (data.config.heroText === 'Promoções selecionadas e verificadas para você economizar sem perder tempo.') {
    data.config.heroText = initialData.config.heroText;
  }

  if ([
    'PromoShop — Ofertas e cupons selecionados',
    'PromoShop Afiliados — Ofertas e cupons selecionados',
    'PromoShop — Ofertas de verdade'
  ].includes(data.config.seoTitle)) {
    data.config.seoTitle = initialData.config.seoTitle;
  }

  if ([
    'Ofertas e cupons selecionados do Mercado Livre, Shopee, AliExpress e Magalu.',
    'Ofertas e cupons selecionados do Mercado Livre, Shopee, AliExpress e Magalu. Compare oportunidades e confirme as condições diretamente na loja.'
  ].includes(data.config.seoDescription)) {
    data.config.seoDescription = initialData.config.seoDescription;
  }

  if (['2026-08-23', '2026-08-23-v2', '2026-08-23-v3', '2026-08-23-v4'].includes(data.config.legalPolicyVersion)) {
    data.config.legalPolicyVersion = initialData.config.legalPolicyVersion;
  }

  data.config.aiModels = {
    ...initialData.config.aiModels,
    ...(data.config.aiModels || {})
  };

  data.config.instagramThemes = sanitizeInstagramThemes(data.config.instagramThemes);
  data.config.instagramHighlights = sanitizeInstagramHighlights(data.config.instagramHighlights);
  data.config.inboxInboundWebhookUrl = String(data.config.inboxInboundWebhookUrl || '').split('?')[0].slice(0, 500);
  data.config.instagramStores = Array.isArray(data.config.instagramStores)
    ? data.config.instagramStores.map((entry) => String(entry).trim()).filter(Boolean)
    : [...initialData.config.instagramStores];
  data.config.instagramAudienceCodes = Array.isArray(data.config.instagramAudienceCodes)
    ? [...new Set(data.config.instagramAudienceCodes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))]
    : [];
  data.config.extensionStores = Array.isArray(data.config.extensionStores)
    ? [...new Set(data.config.extensionStores.map((entry) => String(entry).trim()).filter(Boolean))]
    : [...initialData.config.extensionStores];
  data.config.extensionAudienceCodes = Array.isArray(data.config.extensionAudienceCodes)
    ? [...new Set(data.config.extensionAudienceCodes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))]
    : [...initialData.config.extensionAudienceCodes];

  if (
    !Array.isArray(data.config.whatsappAudiences) ||
    !data.config.whatsappAudiences.length
  ) {
    data.config.whatsappAudiences =
      DEFAULT_WHATSAPP_AUDIENCES.map((audience) => ({
        ...audience,
        keywords: [...(audience.keywords || [])]
      }));
  }

  const femaleDefault = DEFAULT_WHATSAPP_AUDIENCES.find((audience) => audience.code === 'G04');
  const savedFemaleAudience = data.config.whatsappAudiences.find((audience) => audience.code === 'G04');
  if (savedFemaleAudience && femaleDefault && !savedFemaleAudience.profile) {
    savedFemaleAudience.profile = 'female';
    savedFemaleAudience.keywords = [
      ...new Set([...(savedFemaleAudience.keywords || []), ...(femaleDefault.keywords || [])])
    ];
    savedFemaleAudience.blockedKeywords = [...(femaleDefault.blockedKeywords || [])];
  }

  if (
    data.config.aiProvider === 'gemini' &&
    data.config.aiModel === 'gemini-2.5-flash-lite'
  ) {
    data.config.aiModel = 'gemini-3.5-flash-lite';
  }
  data.meta = { ...initialData.meta, ...(data.meta || {}), whatsapp: { ...initialData.meta.whatsapp, ...(data.meta?.whatsapp || {}) } };
  data.offers ||= [];
  data.coupons ||= [];
  data.inbox ||= [];
  data.privacyConsents = data.privacyConsents && typeof data.privacyConsents === 'object'
    ? data.privacyConsents
    : {};
  data.queue ||= [];
  data.instagramQueue ||= [];
  data.instagramFeedQueue ||= [];
  data.logs ||= [];
  data.analytics = {
    ...initialData.analytics,
    ...(data.analytics || {}),
    visitors: {
      ...initialData.analytics.visitors,
      ...(data.analytics?.visitors || {})
    },
    daily: {
      ...initialData.analytics.daily,
      ...(data.analytics?.daily || {})
    }
  };
  return data;
}

const FULL_WHATSAPP_HISTORY = 500;
const MAX_WHATSAPP_OTHER_TERMINAL_HISTORY = 1000;
const FULL_INSTAGRAM_HISTORY = 100;
const MAX_INSTAGRAM_TERMINAL_HISTORY = 1000;

function compactInstagramHistoryItem(item, feed = false) {
  if (item.historyCompacted === true) return item;
  const compact = {
    id: item.id,
    kind: item.kind,
    postType: item.postType,
    sourceId: item.sourceId,
    sourceIds: item.sourceIds,
    title: item.title,
    store: item.store,
    status: item.status,
    origin: item.origin,
    createdAt: item.createdAt,
    publishedAt: item.publishedAt,
    scheduledFor: item.scheduledFor,
    themeId: item.themeId,
    mediaId: item.mediaId,
    error: item.status === 'failed' ? item.error : null,
    historyCompacted: true
  };
  if (feed && Array.isArray(item.items)) {
    compact.items = item.items.map((story) => ({
      sourceId: story.sourceId,
      kind: story.kind,
      sourcePublishedAt: story.sourcePublishedAt
    }));
  }
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined && value !== null));
}

export function compactStoreHistory(data) {
  // As filas recebem itens com push(), portanto os registros mais novos ficam
  // no fim. Percorrer uma vez de trás para frente evita ordenar todo o
  // histórico em cada heartbeat do WhatsApp ou atualização do painel.
  let fullWhatsappItems = 0;
  let otherTerminalItems = 0;
  let removedSentItems = 0;
  const removableWhatsappIndexes = [];
  const whatsappQueue = Array.isArray(data.queue) ? data.queue : [];
  for (let index = whatsappQueue.length - 1; index >= 0; index -= 1) {
    const item = whatsappQueue[index];
    if (item?.status === 'sent') {
      fullWhatsappItems += 1;
      if (fullWhatsappItems > FULL_WHATSAPP_HISTORY) {
        recordSentSourceInLedger(data, item);
        removableWhatsappIndexes.push(index);
        removedSentItems += 1;
      }
      continue;
    }
    if (['failed', 'skipped', 'cancelled'].includes(item?.status)) {
      otherTerminalItems += 1;
      if (otherTerminalItems > MAX_WHATSAPP_OTHER_TERMINAL_HISTORY) removableWhatsappIndexes.push(index);
    }
  }
  for (const index of removableWhatsappIndexes) whatsappQueue.splice(index, 1);
  if (removedSentItems > 0) {
    data.meta ||= {};
    data.meta.whatsappSentHistoryCount = Math.max(0, Number(data.meta.whatsappSentHistoryCount) || 0) + removedSentItems;
  }

  for (const [key, feed] of [['instagramQueue', false], ['instagramFeedQueue', true]]) {
    const queue = Array.isArray(data[key]) ? data[key] : [];
    let terminalItems = 0;
    const removableIndexes = [];
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index];
      if (!['sent', 'cancelled', 'failed'].includes(item?.status)) continue;
      terminalItems += 1;
      if (terminalItems > MAX_INSTAGRAM_TERMINAL_HISTORY) {
        removableIndexes.push(index);
      } else if (terminalItems > FULL_INSTAGRAM_HISTORY && item.historyCompacted !== true) {
        queue[index] = compactInstagramHistoryItem(item, feed);
      }
    }
    // Registros encerrados muito antigos não participam mais da janela de
    // repetição e só aumentavam indefinidamente o arquivo do banco.
    for (const index of removableIndexes) {
      queue.splice(index, 1);
    }
  }
  return data;
}

async function updateFileStore(mutator) {
  writeChain = writeChain.catch(() => { }).then(async () => {
    const data = structuredClone(await readFileStore());
    const result = await mutator(data);
    compactStoreHistory(data);
    const temporaryFile = path.join(dataDir, `db-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(temporaryFile, JSON.stringify(await protectSensitiveData(data)), { encoding: 'utf8', mode: 0o600 });
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temporaryFile, dataFile);
          break;
        } catch (error) {
          if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
        }
      }
    } catch (error) {
      await fs.unlink(temporaryFile).catch(() => { });
      throw error;
    }
    const stats = await fs.stat(dataFile);
    cachedData = data;
    cachedSignature = storeSignature(stats);
    return result;
  });
  return writeChain;
}

function getPostgresBackend() {
  if (postgresBackend) return postgresBackend;
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('STORE_BACKEND=postgres exige a variável DATABASE_URL. O banco em arquivo não foi alterado.');
  }
  postgresBackend = createPostgresStateBackend({
    connectionString,
    loadInitialData: async () => structuredClone(await readFileStore()),
    normalizeData: normalizeStoreData,
    restoreData: restoreSensitiveData,
    protectData: protectSensitiveData,
    retireDataKey: retireLocalDataKey,
    compactData: compactStoreHistory
  });
  return postgresBackend;
}

export function getStoreBackendStatus() {
  if (configuredStoreBackend === 'postgres') {
    return postgresBackend?.status() || {
      backend: 'postgres',
      configured: Boolean(String(process.env.DATABASE_URL || '').trim()),
      connected: false,
      cachedVersion: null
    };
  }
  return {
    backend: 'file',
    configured: true,
    connected: true,
    cachedVersion: null
  };
}

export async function readStore() {
  if (configuredStoreBackend === 'postgres') return getPostgresBackend().read();
  return readFileStore();
}

export async function readStoreSlice(keys = []) {
  const selected = [...new Set(keys)].filter((key) => Object.hasOwn(initialData, key));
  if (configuredStoreBackend === 'postgres') return getPostgresBackend().readKeys(selected);
  const data = await readFileStore();
  return Object.fromEntries(selected.map((key) => [key, data[key]]));
}

export async function updateStore(mutator) {
  if (configuredStoreBackend === 'postgres') return getPostgresBackend().update(mutator);
  return updateFileStore(mutator);
}

export async function checkStoreHealth() {
  try {
    if (configuredStoreBackend === 'postgres') return await getPostgresBackend().check();
    await readFileStore();
    return true;
  } catch {
    return false;
  }
}

export function createId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export async function addLog(message, level = 'info') {
  return updateStore((data) => {
    data.logs.unshift({ id: createId('log'), message, level, createdAt: new Date().toISOString() });
    data.logs = data.logs.slice(0, 200);
  });
}

export async function addLogs(entries = []) {
  const logs = entries
    .filter((entry) => entry?.message)
    .map((entry) => ({
      id: createId('log'),
      message: String(entry.message),
      level: entry.level || 'info',
      createdAt: entry.createdAt || new Date().toISOString()
    }));
  if (!logs.length) return;
  return updateStore((data) => {
    data.logs ||= [];
    data.logs.unshift(...[...logs].reverse());
    data.logs = data.logs.slice(0, 200);
  });
}

export function addBufferedLog(message, level = 'info') {
  bufferedLogs.push({ id: createId('log'), message, level, createdAt: new Date().toISOString() });
  scheduleBufferedLogFlush();
}
