// Permissões do painel administrativo.
//
// Este módulo não conhece o Express nem o armazenamento. Ele concentra apenas
// as regras de autorização para que a API e a interface usem exatamente o
// mesmo vocabulário.

export const ADMIN_PERMISSION_LEVELS = Object.freeze(['none', 'view', 'edit']);

export const ADMIN_PERMISSION_DEFINITIONS = Object.freeze([
  { key: 'overview', label: 'Visão geral', group: 'Operação', viewOnly: true },
  { key: 'offers', label: 'Ofertas', group: 'Operação' },
  { key: 'review', label: 'Revisar ofertas', group: 'Operação' },
  { key: 'coupons', label: 'Cupons', group: 'Operação' },
  { key: 'inbox', label: 'Caixa de entrada', group: 'Operação' },
  { key: 'queue', label: 'Fila de publicação', group: 'Operação' },
  { key: 'sources', label: 'Fontes de ofertas', group: 'Automação' },
  { key: 'whatsapp', label: 'WhatsApp', group: 'Automação' },
  { key: 'groupDirectory', label: 'Divulgar grupos', group: 'Automação' },
  { key: 'instagram', label: 'Instagram Stories', group: 'Automação' },
  { key: 'instagramFeed', label: 'Instagram Feed', group: 'Automação' },
  { key: 'instagramShare', label: 'Compartilhar no Instagram', group: 'Automação' },
  { key: 'instagramHighlights', label: 'Destaques do Instagram', group: 'Automação' },
  { key: 'extensionCoupons', label: 'Extensão de cupons', group: 'Automação' },
  { key: 'extensionMercadoLivre', label: 'Extensão Mercado Livre', group: 'Automação' },
  { key: 'analytics', label: 'Acessos', group: 'Sistema' },
  { key: 'health', label: 'Saúde e backup', group: 'Sistema' },
  { key: 'monitoring', label: 'Monitoramento', group: 'Sistema' },
  { key: 'settings', label: 'Site e políticas', group: 'Sistema' },
  { key: 'logs', label: 'Atividades', group: 'Sistema' }
]);

const PERMISSION_KEYS = new Set(ADMIN_PERMISSION_DEFINITIONS.map((item) => item.key));
const VIEW_ONLY_KEYS = new Set(ADMIN_PERMISSION_DEFINITIONS.filter((item) => item.viewOnly).map((item) => item.key));

export function defaultAdminPermissions(role = 'viewer') {
  const normalizedRole = String(role || 'viewer');
  const level = normalizedRole === 'editor' || normalizedRole === 'owner' ? 'edit' : 'view';
  return Object.fromEntries(ADMIN_PERMISSION_DEFINITIONS.map(({ key, viewOnly }) => [
    key,
    viewOnly ? 'view' : level
  ]));
}

export function normalizeAdminPermissions(value, role = 'viewer') {
  const defaults = defaultAdminPermissions(role);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;

  // Quando o proprietário envia uma matriz explícita, campos omitidos ficam
  // sem acesso. Isso evita que um objeto parcial conceda acidentalmente o
  // perfil completo de editor.
  const normalized = Object.fromEntries(ADMIN_PERMISSION_DEFINITIONS.map(({ key, viewOnly }) => [
    key,
    viewOnly ? 'view' : 'none'
  ]));
  for (const key of PERMISSION_KEYS) {
    const requested = String(value[key] || '').toLowerCase();
    if (!ADMIN_PERMISSION_LEVELS.includes(requested)) continue;
    normalized[key] = VIEW_ONLY_KEYS.has(key) && requested === 'edit' ? 'view' : requested;
  }
  // Todo usuário secundário consegue abrir um resumo mínimo para sair da
  // tela de login, mesmo quando o proprietário removeu todas as outras áreas.
  normalized.overview = 'view';
  return normalized;
}

export function adminPermissionAllows(permissions, key, required = 'view') {
  const requested = String(required || 'view').toLowerCase();
  if (!ADMIN_PERMISSION_LEVELS.includes(requested) || !PERMISSION_KEYS.has(String(key))) return false;
  const current = String(permissions?.[key] || 'none').toLowerCase();
  if (requested === 'none') return true;
  if (requested === 'view') return current === 'view' || current === 'edit';
  return current === 'edit';
}

export function permissionLevelLabel(level) {
  return level === 'edit' ? 'Editar' : level === 'view' ? 'Consulta' : 'Sem acesso';
}

export function permissionProfileLabel(permissions, role = 'viewer') {
  const normalized = normalizeAdminPermissions(permissions, role);
  const editable = ADMIN_PERMISSION_DEFINITIONS.filter(({ key }) => normalized[key] === 'edit').length;
  const visible = ADMIN_PERMISSION_DEFINITIONS.filter(({ key }) => normalized[key] === 'view' || normalized[key] === 'edit').length;
  const total = ADMIN_PERMISSION_DEFINITIONS.length;
  if (editable === total - 1) return 'Editor completo';
  if (editable > 0) return `${editable} área(s) com edição`;
  if (visible === 1) return 'Visão geral';
  return `${visible} área(s) em consulta`;
}

// Rotas de dados do painel. GET exige consulta; gravações exigem edição.
// Rotas de credenciais e usuários continuam exclusivas do proprietário.
export function adminPermissionForPath(pathname = '') {
  const rawPath = String(pathname || '').split('?')[0];
  const path = rawPath.startsWith('/admin/') ? `/api${rawPath}` : rawPath;
  if (!path.startsWith('/api/admin/')) return null;
  if (path === '/api/admin/config') return null; // decidido por chave abaixo
  if (/^\/api\/admin\/(users|secrets)(?:\/|$)/.test(path)) return '__owner__';
  if (path === '/api/admin/dashboard') return 'overview';
  if (/^\/api\/admin\/(offers|search-products)(?:\/|$)/.test(path)) return 'offers';
  if (/^\/api\/admin\/coupons(?:\/|$)/.test(path)) return 'coupons';
  if (/^\/api\/admin\/queue(?:\/|$)/.test(path)) return 'queue';
  if (path === '/api/admin/inbox-state' || /^\/api\/admin\/inbox(?:\/|$)/.test(path)) return 'inbox';
  if (/^\/api\/admin\/group-directory(?:\/|$)/.test(path)) return 'groupDirectory';
  if (/^\/api\/admin\/whatsapp(?:\/|$)/.test(path)) return 'whatsapp';
  if (/^\/api\/admin\/instagram\/feed(?:\/|$)/.test(path)) return 'instagramFeed';
  if (/^\/api\/admin\/instagram\/highlights(?:\/|$)/.test(path)) return 'instagramHighlights';
  // Os templates usam tanto `/share-preview` quanto `/share-template`; os
  // dois pertencem à área de compartilhamento manual, não à conexão do
  // Instagram Stories.
  if (/^\/api\/admin\/instagram\/share(?:[-/]|$)/.test(path)) return 'instagramShare';
  if (path === '/api/admin/instagram-state' || /^\/api\/admin\/instagram(?:\/|$)/.test(path)) return 'instagram';
  if (/^\/api\/admin\/extension\/mercadolivre(?:\/|$)/.test(path)) return 'extensionMercadoLivre';
  if (/^\/api\/admin\/extension\/coupons(?:\/|$)/.test(path)) return 'extensionCoupons';
  if (/^\/api\/admin\/extension(?:\/|$)/.test(path)) return 'extensionCoupons';
  if (/^\/api\/admin\/(sources|collect|ai|search-products)(?:\/|$)/.test(path)) return 'sources';
  if (/^\/api\/admin\/search-console(?:\/|$)/.test(path)) return 'analytics';
  if (/^\/api\/admin\/(backup|maintenance)(?:\/|$)/.test(path)) return 'health';
  if (/^\/api\/admin\/(monitoring|price-monitors)(?:\/|$)/.test(path)) return 'monitoring';
  if (path === '/api/admin/campaigns-state' || /^\/api\/admin\/campaigns(?:\/|$)/.test(path)) return 'offers';
  // Uma rota nova não deve virar uma brecha para contas secundárias.
  return '__owner__';
}

const CONFIG_SCOPE_SETS = Object.freeze({
  sources: new Set([
    'enableMercadoLivre', 'enableShopee', 'enableAliexpress', 'enableMagalu', 'enableNetshoes',
    'mercadoLivreQueries', 'mercadoLivreRedirectUri', 'shopeeQueries', 'aliexpressQueries',
    'aliexpressTrackingId', 'minDiscount', 'collectionIntervalMinutes', 'autoQueue',
    'maxPostsPerDay', 'maxPostsPerAudiencePerDay'
  ]),
  whatsapp: new Set([
    'whatsappAudiences', 'whatsappGroups', 'whatsappGroupId', 'whatsappGroupName', 'whatsappUrl',
    'whatsappCommunityEnabled', 'whatsappCommunityName', 'whatsappMentionAllEnabled',
    'whatsappMaxPerHour', 'whatsappIntervalMinutes', 'whatsappMinDelaySeconds', 'whatsappMaxDelaySeconds',
    'whatsappAudienceRoundEnabled', 'whatsappOneOfferPerAudiencePerRound', 'whatsappAudienceDelaySeconds',
    'whatsappUniqueOfferPerRound', 'whatsappAudienceCooldownHours', 'publishingStart', 'publishingEnd',
    'quietStart', 'quietEnd', 'whatsappHeadless', 'whatsappAutoStart'
  ]),
  groupDirectory: new Set([
    'whatsappDirectoryTitle', 'whatsappDirectoryIntro', 'whatsappDirectoryFooter',
    'whatsappDirectoryIncludedCodes', 'whatsappDirectoryTargetCodes'
  ]),
  instagramFeed: new Set([
    'instagramFeedEnabled', 'instagramFeedAutoFromWhatsapp', 'instagramFeedPostType', 'instagramFeedFormat',
    'instagramFeedTemplateMode', 'instagramFeedCarouselFrequency', 'instagramFeedCarouselsPerDay',
    'instagramFeedCarouselsPerWeek', 'instagramFeedPublishingStart', 'instagramFeedPublishingEnd',
    'instagramFeedPublishingDays', 'instagramFeedIntervalMinutes', 'instagramFeedMaxPerDay',
    'instagramFeedMinimumDiscount', 'instagramFeedDuplicateDays', 'instagramFeedCarouselSize', 'instagramFeedCaption'
  ]),
  instagramHighlights: new Set(['instagramHighlights']),
  extensionCoupons: new Set([
    'extensionEnabled', 'extensionAutoApprove', 'extensionStores', 'extensionAudienceCodes', 'extensionMaxCouponsPerRequest'
  ]),
  instagram: new Set([
    'instagramEnabled', 'instagramAutoFromWhatsapp', 'instagramIncludeCoupons', 'instagramApiVersion',
    'instagramRedirectUri', 'instagramPublishingStart', 'instagramPublishingEnd', 'instagramIntervalMinutes',
    'instagramMaxPerDay', 'instagramMinimumDiscount', 'instagramDuplicateDays', 'instagramStores',
    'instagramAudienceCodes', 'instagramThemeMode', 'instagramManualThemeId', 'instagramThemes',
    'instagramCtaText', 'instagramDisclosureText', 'instagramShowQrCode', 'instagramAssetRetentionHours'
  ]),
  monitoring: new Set([
    'monitoringEnabled', 'monitoringEmail', 'monitoringWhatsappMinutes', 'monitoringCollectionHours',
    'monitoringFailedQueueLimit', 'monitoringWhatsappEnabled', 'monitoringWhatsappRecipient',
    'monitoringWhatsappIncludeInfo', 'monitoringWhatsappDeployAlerts', 'monitoringWhatsappServerAlerts',
    'monitoringWhatsappCooldownMinutes', 'priceMonitoringEnabled'
  ]),
  analytics: new Set([
    'clickAnalyticsEnabled', 'analyticsVisitorRetentionDays', 'analyticsDailyRetentionDays',
    'searchConsoleSiteUrl', 'searchConsoleRedirectUri'
  ]),
  health: new Set(['automaticBackupEnabled', 'automaticBackupRetention', 'linkCheckEnabled', 'linkCheckAutoPause', 'linkCheckBatchSize']),
  review: new Set([
    'qualityFilterEnabled', 'qualityMinimumScore', 'qualityRequireImage', 'qualityRequireHttpsLink',
    'qualityMaxTitleLength', 'qualityBlockedTerms', 'staleOffersHidden', 'smartRankingEnabled',
    'rankingDiscountWeight', 'rankingFreshnessWeight', 'rankingQualityWeight', 'rankingClicksWeight',
    'duplicateGroupingEnabled', 'rankingDiversityEnabled', 'publicOfferPageSize', 'publicOfferMaxAgeDays',
    'publicAdvancedFiltersEnabled'
  ]),
  offers: new Set(['aiEnabled', 'aiProvider', 'aiModel', 'aiBaseUrl', 'aiOllamaUrl', 'aiFallbackEnabled', 'aiProviderOrder', 'aiModels', 'aiTone', 'aiInstructions', 'messageTemplate', 'campaignsEnabled']),
  inbox: new Set(['inboxInboundEnabled', 'inboxInboundDomain']),
  settings: new Set([
    'brandName', 'heroTitle', 'heroText', 'primaryColor', 'instagramUrl', 'disclosure', 'contactEmail',
    'canonicalUrl', 'seoSiteName', 'seoTitle', 'seoDescription', 'seoKeywords', 'seoImageUrl',
    'seoIndexingEnabled', 'seoStructuredDataEnabled', 'showOfferUpdatedAt', 'affiliateDisclosureLabel',
    'mobileCompactMenu', 'assistantEnabled', 'favoritesEnabled', 'legalResponsibleName', 'legalResponsibleType',
    'legalCityState', 'legalPrivacyEmail', 'legalResponseBusinessDays', 'legalContactRetentionMonths',
    'legalConsentRetentionYears', 'legalAffiliatePrograms', 'legalPolicyVersion', 'legalAboutCustomText',
    'legalContactCustomText', 'legalTermsCustomText', 'legalPrivacyCustomText', 'consentReceiptRetentionYears',
    'contactRetentionMonths', 'aiAudienceRoutingEnabled', 'aiAudienceRoutingMaxGroups', 'aiAudienceRoutingRequireMatch',
    'aiGeneralAudienceCode', 'aiDealsAudienceCode'
  ])
});

export function configPermissionKey(key) {
  const name = String(key || '');
  for (const [scope, keys] of Object.entries(CONFIG_SCOPE_SETS)) {
    if (keys.has(name)) return scope;
  }
  if (name.startsWith('instagramFeed')) return 'instagramFeed';
  if (name.startsWith('instagram')) return 'instagram';
  if (name.startsWith('whatsappDirectory')) return 'groupDirectory';
  if (name.startsWith('whatsapp')) return 'whatsapp';
  if (name.startsWith('monitoring') || name === 'priceMonitoringEnabled') return 'monitoring';
  if (name.startsWith('extension')) return 'extensionCoupons';
  if (name.startsWith('searchConsole') || name.startsWith('analytics')) return 'analytics';
  if (name.startsWith('automaticBackup') || name.startsWith('linkCheck')) return 'health';
  if (name.startsWith('quality') || name.startsWith('ranking') || name.startsWith('publicOffer')) return 'review';
  if (name.startsWith('ai') || name === 'messageTemplate') return 'offers';
  return 'settings';
}

export function configPermissionScopes(key) {
  const scope = configPermissionKey(key);
  // A shared extension setting is usable by either extension panel. Requiring
  // one of the two grants lets the owner delegate only the desired panel.
  if (scope === 'extensionCoupons' && ['extensionStores', 'extensionAudienceCodes', 'extensionEnabled'].includes(String(key))) {
    return ['extensionCoupons', 'extensionMercadoLivre'];
  }
  return [scope];
}
