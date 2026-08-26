import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  DEFAULT_WHATSAPP_AUDIENCES
} from './audienceRouting.js';
import { DEFAULT_INSTAGRAM_THEMES, sanitizeInstagramThemes } from './instagramThemes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const dataFile = path.join(dataDir, 'db.json');
const dataKeyFile = path.join(dataDir, '.data-key');
let dataMigrationPromise = null;

async function getDataKey() {
  const configured = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const saved = (await fs.readFile(dataKeyFile, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(saved)) return Buffer.from(saved, 'hex');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(32);
  await fs.writeFile(dataKeyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

async function encryptSensitive(value) {
  const key = await getDataKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
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
  const key = await getDataKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]);
  return { value: JSON.parse(plain.toString('utf8')), encrypted: true };
}

async function restoreSensitiveData(data) {
  let encrypted = true;
  for (const key of ['inbox', 'privacyConsents']) {
    const restored = await decryptSensitive(data[key]);
    data[key] = restored.value;
    encrypted &&= restored.encrypted;
  }
  if (data.analytics && typeof data.analytics === 'object') {
    const restored = await decryptSensitive(data.analytics.visitors);
    data.analytics.visitors = restored.value;
    encrypted &&= restored.encrypted;
  }
  return { data, encrypted };
}

async function protectSensitiveData(data) {
  const persisted = structuredClone(data);
  persisted.inbox = await encryptSensitive(persisted.inbox || []);
  persisted.privacyConsents = await encryptSensitive(persisted.privacyConsents || {});
  persisted.analytics ||= {};
  persisted.analytics.visitors = await encryptSensitive(persisted.analytics.visitors || {});
  return persisted;
}

async function writeProtectedSnapshot(data) {
  const temporaryFile = path.join(dataDir, `db-migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(temporaryFile, JSON.stringify(await protectSensitiveData(data), null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryFile, dataFile);
}

const initialData = {
  config: {
    brandName: 'PromoShop',
    heroTitle: 'Ofertas boas não esperam.',
    heroText: 'Promoções selecionadas e organizadas para você economizar sem perder tempo.',
    primaryColor: '#1269f3',
    whatsappUrl: '#',
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
      'https://promoshop.onrender.com/api/mercadolivre/callback',

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

    whatsappMaxPerHour: 100,
    whatsappIntervalMinutes: 15,

    whatsappMinDelaySeconds: 12,
    whatsappMaxDelaySeconds: 30,

    whatsappAudienceRoundEnabled: true,

    whatsappOneOfferPerAudiencePerRound: true,

    whatsappAudienceDelaySeconds: 15,

    whatsappUniqueOfferPerRound: true,

    whatsappAudienceCooldownHours: 24,

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

async function ensureStore() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await fs.mkdir(dataDir, { recursive: true });
      try { await fs.access(dataFile); }
      catch { await fs.writeFile(dataFile, JSON.stringify(await protectSensitiveData(initialData), null, 2), { encoding: 'utf8', mode: 0o600 }); }
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

export async function readStore() {
  await ensureStore();
  const stats = await fs.stat(dataFile);
  const signature = storeSignature(stats);
  if (cachedData && cachedSignature === signature) return cachedData;

  let data;
  let wasEncrypted = false;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const persisted = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      const restored = await restoreSensitiveData(persisted);
      data = restored.data;
      wasEncrypted = restored.encrypted;
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
  data.config = {
    ...initialData.config,
    ...(data.config || {})
  };

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
  cachedData = data;
  cachedSignature = signature;
  return data;
}

export async function updateStore(mutator) {
  writeChain = writeChain.catch(() => { }).then(async () => {
    const data = structuredClone(await readStore());
    const result = await mutator(data);
    const temporaryFile = path.join(dataDir, `db-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(temporaryFile, JSON.stringify(await protectSensitiveData(data), null, 2), { encoding: 'utf8', mode: 0o600 });
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

export function createId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export async function addLog(message, level = 'info') {
  return updateStore((data) => {
    data.logs.unshift({ id: createId('log'), message, level, createdAt: new Date().toISOString() });
    data.logs = data.logs.slice(0, 200);
  });
}
