import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const fallbackConfig = {
  brandName: 'PromoShop',
  heroTitle: 'Ofertas boas não esperam.',
  heroText: 'Promoções selecionadas e organizadas para você economizar sem perder tempo.',
  primaryColor: '#1269f3',
  whatsappUrl: '#',
  whatsappAudiences: [],
  assistantAvailable: false,
  assistantEnabled: true,
  disclosure: 'Podemos receber comissão pelas compras, sem custo adicional para você.',
  contactEmail: 'contatopromoshop.site@gmail.com',
  inboxInboundEnabled: false,
  inboxInboundDomain: 'reply.jhonatafaraujo.com.br',
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
  legalPolicyVersion: '2026-08-23-v3',
  legalAboutCustomText: '',
  legalContactCustomText: '',
  legalTermsCustomText: '',
  legalPrivacyCustomText: ''
};

const mercadoLivreCategories = [
  { id: 'MLB5672', name: 'Acessórios para Veículos' },
  { id: 'MLB271599', name: 'Agro' },
  { id: 'MLB1403', name: 'Alimentos e Bebidas' },
  { id: 'MLB1071', name: 'Animais e Pet Shop' },
  { id: 'MLB1367', name: 'Antiguidades e Coleções' },
  { id: 'MLB1368', name: 'Arte, Papelaria e Armarinho' },
  { id: 'MLB1384', name: 'Bebês' },
  { id: 'MLB1246', name: 'Beleza e Cuidado Pessoal' },
  { id: 'MLB1132', name: 'Brinquedos e Hobbies' },
  { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
  { id: 'MLB1039', name: 'Câmeras e Acessórios' },
  { id: 'MLB1743', name: 'Carros, Motos e Outros' },
  { id: 'MLB1574', name: 'Casa, Móveis e Decoração' },
  { id: 'MLB1051', name: 'Celulares e Telefones' },
  { id: 'MLB1500', name: 'Construção' },
  { id: 'MLB5726', name: 'Eletrodomésticos' },
  { id: 'MLB1000', name: 'Eletrônicos, Áudio e Vídeo' },
  { id: 'MLB1276', name: 'Esportes e Fitness' },
  { id: 'MLB263532', name: 'Ferramentas' },
  { id: 'MLB12404', name: 'Festas e Lembrancinhas' },
  { id: 'MLB1144', name: 'Games' },
  { id: 'MLB1499', name: 'Indústria e Comércio' },
  { id: 'MLB1648', name: 'Informática' },
  { id: 'MLB1182', name: 'Instrumentos Musicais' },
  { id: 'MLB3937', name: 'Joias e Relógios' },
  { id: 'MLB1196', name: 'Livros, Revistas e Comics' },
  { id: 'MLB1168', name: 'Música, Filmes e Seriados' },
  { id: 'MLB264586', name: 'Saúde' }
];

const fallbackOffers = [
  { id: 'demo-1', title: 'Fone Bluetooth com cancelamento de ruído', store: 'Mercado Livre', category: 'Eletrônicos', price: 129.9, originalPrice: 219.9, image: 'https://http2.mlstatic.com/D_NQ_NP_2X_629644-MLA79812359049_102024-F.webp', affiliateUrl: '#', featured: true, freeShipping: true },
  { id: 'demo-2', title: 'Kit organizador para cozinha', store: 'Shopee', category: 'Casa', price: 49.9, originalPrice: 89.9, image: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=900&q=80', affiliateUrl: '#', featured: true, freeShipping: false },
  { id: 'demo-3', title: 'Smartwatch esportivo resistente à água', store: 'Mercado Livre', category: 'Tecnologia', price: 159.9, originalPrice: 299.9, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=80', affiliateUrl: '#', featured: false, freeShipping: true }
];

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    ...options,
    headers
  });
  if (!response.ok) {
    const error = new Error((await response.json().catch(() => ({}))).error || 'Falha na solicitação');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function anonymousStorageId(storage, key) {
  try {
    const current = storage.getItem(key);
    if (current) return current;

    const generated = window.crypto?.randomUUID
      ? window.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

    storage.setItem(key, generated);
    return generated;
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

const analyticsConsentKey = 'promoshop_analytics_consent';
const analyticsConsentEvent = 'promoshop:analytics-consent';
const privacyOpenEvent = 'promoshop:privacy-open';
const privacyPolicyVersion = '2026-08-23-v3';
const privacyReceiptKey = 'promoshop_privacy_receipt';
const privacyReceiptSyncKey = 'promoshop_privacy_receipt_synced';

function readAnalyticsConsent() {
  try {
    const value = window.localStorage.getItem(analyticsConsentKey);
    return value === 'accepted' || value === 'rejected' ? value : '';
  } catch {
    return '';
  }
}

function clearAnalyticsIdentifiers() {
  try {
    window.localStorage.removeItem('promoshop_analytics_visitor');
    window.sessionStorage.removeItem('promoshop_analytics_session');
    window.sessionStorage.removeItem('promoshop_analytics_pageview');
  } catch { }
}

function recordAnalyticsConsent(value, previousVisitorId = '', policyVersion = privacyPolicyVersion) {
  const receiptId = anonymousStorageId(window.localStorage, privacyReceiptKey);
  api('/privacy/consent', {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify({
      receiptId,
      choice: value,
      policyVersion,
      previousVisitorId
    })
  }).then(() => {
    try {
      window.localStorage.setItem(privacyReceiptSyncKey, `${policyVersion}:${value}`);
    } catch { }
  }).catch(() => { });
}

function saveAnalyticsConsent(value, policyVersion = privacyPolicyVersion) {
  let previousVisitorId = '';
  try {
    previousVisitorId = window.localStorage.getItem('promoshop_analytics_visitor') || '';
  } catch { }
  try {
    window.localStorage.setItem(analyticsConsentKey, value);
  } catch { }
  if (value === 'rejected') clearAnalyticsIdentifiers();
  recordAnalyticsConsent(value, value === 'rejected' ? previousVisitorId : '', policyVersion);

  window.dispatchEvent(new CustomEvent(analyticsConsentEvent, { detail: value }));
}

function trackPublicEvent(type, target = {}) {
  if (readAnalyticsConsent() !== 'accepted') return;
  let receiptId = '';
  try { receiptId = window.localStorage.getItem(privacyReceiptKey) || ''; } catch { }
  if (!receiptId) return;

  const visitorId = anonymousStorageId(window.localStorage, 'promoshop_analytics_visitor');
  const sessionId = anonymousStorageId(window.sessionStorage, 'promoshop_analytics_session');
  api('/analytics/event', {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify({
      receiptId,
      visitorId,
      sessionId,
      type,
      targetId: String(target.id || '').slice(0, 120),
      label: String(target.label || '').slice(0, 180),
      store: String(target.store || '').slice(0, 80)
    })
  }).catch(() => { });
}

function usePublicAnalytics() {
  const analyticsSentRef = useRef(false);
  const [consent, setConsent] = useState(readAnalyticsConsent);

  useEffect(() => {
    const updateConsent = (event) => setConsent(event.detail || readAnalyticsConsent());
    const syncConsent = (event) => {
      if (event.key === analyticsConsentKey) setConsent(readAnalyticsConsent());
    };

    window.addEventListener(analyticsConsentEvent, updateConsent);
    window.addEventListener('storage', syncConsent);
    return () => {
      window.removeEventListener(analyticsConsentEvent, updateConsent);
      window.removeEventListener('storage', syncConsent);
    };
  }, []);

  useEffect(() => {
    if (consent !== 'accepted') return;
    if (analyticsSentRef.current) return;
    analyticsSentRef.current = true;

    try {
      const lastSentAt = Number(window.sessionStorage.getItem('promoshop_analytics_pageview') || 0);
      if (lastSentAt && Date.now() - lastSentAt < 10000) return;
      window.sessionStorage.setItem('promoshop_analytics_pageview', String(Date.now()));
    } catch { }

    const visitorId = anonymousStorageId(window.localStorage, 'promoshop_analytics_visitor');
    const sessionId = anonymousStorageId(window.sessionStorage, 'promoshop_analytics_session');
    const receiptId = anonymousStorageId(window.localStorage, privacyReceiptKey);

    api('/analytics/visit', {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({
        visitorId,
        sessionId,
        receiptId,
        path: window.location.pathname
      })
    }).catch(() => { });
  }, [consent]);
}

function PrivacyConsent({ policyVersion = privacyPolicyVersion }) {
  const [choice, setChoice] = useState(readAnalyticsConsent);
  const [open, setOpen] = useState(() => !readAnalyticsConsent());

  useEffect(() => {
    if (!choice) clearAnalyticsIdentifiers();
    if (choice) {
      let synced = '';
      try { synced = window.localStorage.getItem(privacyReceiptSyncKey) || ''; } catch { }
      if (synced !== `${policyVersion}:${choice}`) setOpen(true);
    }

    const showPreferences = () => setOpen(true);
    const syncChoice = () => {
      const nextChoice = readAnalyticsConsent();
      setChoice(nextChoice);
      if (nextChoice) setOpen(false);
    };

    window.addEventListener(privacyOpenEvent, showPreferences);
    window.addEventListener('storage', syncChoice);
    return () => {
      window.removeEventListener(privacyOpenEvent, showPreferences);
      window.removeEventListener('storage', syncChoice);
    };
  }, [choice, policyVersion]);

  function choose(value) {
    saveAnalyticsConsent(value, policyVersion);
    setChoice(value);
    setOpen(false);
  }

  if (!open) return null;

  return <aside className="privacy-consent" role="dialog" aria-label="Preferências de privacidade" aria-live="polite">
    <div className="privacy-consent-icon" aria-hidden="true">✓</div>
    <div className="privacy-consent-copy">
      <strong>Privacidade e medição de acessos</strong>
      <p>Com sua autorização, usamos um identificador anônimo no navegador para contar visitas e interações com ofertas, cupons e grupos. Não guardamos seu nome ou IP nessa medição. O site continua funcionando normalmente se você rejeitar.</p>
      <span><a href="/privacidade">Política de Privacidade</a><a href="/termos-de-uso">Termos de Uso</a>{choice && <small>Escolha atual: {choice === 'accepted' ? 'medição aceita' : 'medição rejeitada'}.</small>}</span>
    </div>
    <div className="privacy-consent-actions">
      <button type="button" className="privacy-reject" onClick={() => choose('rejected')}>Rejeitar</button>
      <button type="button" className="privacy-accept" onClick={() => choose('accepted')}>Aceitar medição</button>
    </div>
  </aside>;
}

function discount(offer) {
  if (!offer.originalPrice || offer.originalPrice <= offer.price) return 0;
  return Math.round((1 - offer.price / offer.originalPrice) * 100);
}

function Logo({ name }) {
  return <a className="logo" href="/" aria-label={`${name} - início`}><span className="logo-mark">%</span>{name}</a>;
}

const favoritesStorageKey = 'promoshop_favorites';
function readFavorites() {
  try { return JSON.parse(localStorage.getItem(favoritesStorageKey) || '[]').filter(Boolean); } catch { return []; }
}

function OfferCard({ offer, config, favorite = false, onFavorite }) {
  return <article className="offer-card">
    <div className="offer-image"><a href={`/oferta/${offer.publicSlug || offer.id}`} aria-label={`Ver detalhes de ${offer.title}`}><img src={offer.image} alt={offer.title} width="640" height="640" loading="lazy" decoding="async" referrerPolicy="no-referrer" /></a>{discount(offer) > 0 && <span className="discount">{discount(offer)}% OFF</span>}<span className={`store-badge ${String(offer.store).toLowerCase().includes('shopee') ? 'shopee' : String(offer.store).toLowerCase().includes('aliexpress') ? 'aliexpress' : 'mercado'}`}>{offer.store}</span>{config.favoritesEnabled !== false && <button type="button" className={`favorite-button ${favorite ? 'active' : ''}`} aria-label={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} onClick={() => onFavorite?.(offer)}>{favorite ? '♥' : '♡'}</button>}</div>
    <div className="offer-content"><div className="offer-meta"><small>{offer.category}</small>{offer.freeShipping && <span className="shipping">Frete grátis</span>}</div><h3><a href={`/oferta/${offer.publicSlug || offer.id}`}>{offer.title}</a></h3><div className="prices"><s>{offer.originalPrice && offer.originalPrice > offer.price ? money.format(offer.originalPrice) : ''}</s><strong>{money.format(offer.price)}</strong><small>Preço, estoque e condições devem ser confirmados na loja.</small></div>{config.showOfferUpdatedAt !== false && (offer.updatedAt || offer.createdAt) && <small className="offer-updated">Atualizada em {new Date(offer.updatedAt || offer.createdAt).toLocaleDateString('pt-BR')}</small>}<small className="affiliate-label">{config.affiliateDisclosureLabel || 'Publicidade · Link de afiliado'}</small><a className="button primary full" href={offer.affiliateUrl} target="_blank" rel="nofollow sponsored noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('offer', { id: offer.id, label: offer.title, store: offer.store })}>Ir para a oferta <span>↗</span></a></div>
  </article>;
}

function PublicSite() {
  const [config, setConfig] = useState(fallbackConfig);
  const [offers, setOffers] = useState([]);
  const [offerTotal, setOfferTotal] = useState(0);
  const [offerStores, setOfferStores] = useState([]);
  const [offerCategories, setOfferCategories] = useState([]);
  const [topDiscount, setTopDiscount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [coupons, setCoupons] = useState([]);
  const [couponCopied, setCouponCopied] = useState('');
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const initialParams = new URLSearchParams(window.location.search);
  const [query, setQuery] = useState(initialParams.get('q') || '');
  const [store, setStore] = useState(pathParts[0] === 'loja' ? pathParts[1] : (initialParams.get('loja') || 'Todas'));
  const [category, setCategory] = useState(pathParts[0] === 'ofertas' ? pathParts[1] : (initialParams.get('categoria') || ''));
  const [sort, setSort] = useState(initialParams.get('ordem') || 'smart');
  const [minPrice, setMinPrice] = useState(initialParams.get('min') || '');
  const [maxPrice, setMaxPrice] = useState(initialParams.get('max') || '');
  const [minDiscount, setMinDiscount] = useState(initialParams.get('desconto') || '');
  const [freeShipping, setFreeShipping] = useState(initialParams.get('frete') === '1');
  const [favorites, setFavorites] = useState(readFavorites);
  const [suggestions, setSuggestions] = useState([]);
  const favoritesOnly = window.location.pathname === '/favoritos';
  const [loading, setLoading] = useState(true);
  const [audiences, setAudiences] = useState([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMessage, setAssistantMessage] = useState('');
  const [assistantMessages, setAssistantMessages] = useState(() => [{
    role: 'assistant',
    content: 'Olá! Eu sou o Assistente PromoShop. Que produto você procura hoje? Conte também como pretende usar; eu posso perguntar o orçamento antes de indicar as melhores opções.'
  }]);
  const [assistantSeenProductIds, setAssistantSeenProductIds] = useState([]);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const assistantBodyRef = useRef(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const offerRequestRef = useRef(0);
  usePublicAnalytics();

  useEffect(() => {
    api('/home')
      .then(({ config: configData, coupons: couponData, audiences: audienceData }) => {
        setConfig({ ...fallbackConfig, ...(configData || {}) });
        setCoupons(Array.isArray(couponData) ? couponData : []);
        setAudiences(Array.isArray(audienceData) ? audienceData : []);
      })
      .catch(() => { });
  }, []);

  async function loadOfferPage({ append = false } = {}) {
    const requestId = ++offerRequestRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);

    try {
      const params = new URLSearchParams({
        paged: '1',
        limit: String(Math.max(6, Math.min(60, Number(config.publicOfferPageSize || 24)))),
        offset: String(append ? offers.length : 0),
        query,
        store: store === 'Todas' ? '' : store,
        category,
        sort,
        minPrice,
        maxPrice,
        minDiscount,
        freeShipping: freeShipping ? '1' : '',
        ids: favoritesOnly ? favorites.slice(0, 100).join(',') : ''
      });
      const result = await api(`/offers?${params.toString()}`);
      if (requestId !== offerRequestRef.current) return;
      const nextOffers = Array.isArray(result.offers) ? result.offers : [];
      setOffers((current) => append ? [...current, ...nextOffers] : nextOffers);
      setOfferTotal(Number(result.total || 0));
      setOfferStores(Array.isArray(result.stores) ? result.stores : []);
      setOfferCategories(Array.isArray(result.categories) ? result.categories : []);
      setTopDiscount(Number(result.topDiscount || 0));
    } catch {
      if (!append) {
        setOffers([]);
        setOfferTotal(0);
      }
    } finally {
      if (requestId === offerRequestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => loadOfferPage(), 280);
    return () => window.clearTimeout(timeout);
  }, [query, store, category, sort, minPrice, maxPrice, minDiscount, freeShipping, favoritesOnly, favorites.join(','), config.publicOfferPageSize]);

  useEffect(() => {
    if (query.trim().length < 2) return setSuggestions([]);
    const timeout = window.setTimeout(() => api(`/search/suggestions?q=${encodeURIComponent(query.trim())}`).then(setSuggestions).catch(() => setSuggestions([])), 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (pathParts[0] === 'loja' || pathParts[0] === 'ofertas' || favoritesOnly) return;
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (store !== 'Todas') params.set('loja', store);
    if (category) params.set('categoria', category);
    if (sort !== 'smart') params.set('ordem', sort);
    if (minPrice) params.set('min', minPrice);
    if (maxPrice) params.set('max', maxPrice);
    if (minDiscount) params.set('desconto', minDiscount);
    if (freeShipping) params.set('frete', '1');
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
  }, [query, store, category, sort, minPrice, maxPrice, minDiscount, freeShipping]);

  useEffect(() => {
    const refreshCoupons = () => {
      if (document.visibilityState === 'hidden') return;

      api('/coupons')
        .then((couponData) => {
          setCoupons(Array.isArray(couponData) ? couponData : []);
        })
        .catch(() => { });
    };

    const interval = window.setInterval(refreshCoupons, 60000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshCoupons();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--primary', config.primaryColor || fallbackConfig.primaryColor);
    const categoryName = offerCategories.find((item) => String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') === category);
    const storeName = offerStores.find((item) => String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') === store);
    document.title = favoritesOnly ? `Favoritos — ${config.brandName}` : categoryName ? `Ofertas de ${categoryName} — ${config.brandName}` : storeName ? `Ofertas do ${storeName} — ${config.brandName}` : (config.seoTitle || `${config.brandName} — Ofertas de verdade`);
    const description = document.querySelector('meta[name="description"]');
    if (description && config.seoDescription) description.setAttribute('content', config.seoDescription);
  }, [config, category, store, favoritesOnly, offerCategories.join(','), offerStores.join(',')]);

  useEffect(() => {
    if (!config.assistantAvailable) {
      setAssistantOpen(false);
    }
  }, [config.assistantAvailable]);

  useEffect(() => {
    if (!assistantOpen) return;
    assistantBodyRef.current?.scrollTo({ top: assistantBodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [assistantOpen, assistantMessages, assistantLoading]);

  const stores = ['Todas', ...offerStores];
  const favoriteSet = new Set(favorites);
  const visibleOffers = favoritesOnly ? offers.filter((offer) => favoriteSet.has(offer.id)) : offers;
  function toggleFavorite(offer) {
    setFavorites((current) => {
      const next = current.includes(offer.id) ? current.filter((id) => id !== offer.id) : [...current, offer.id];
      localStorage.setItem(favoritesStorageKey, JSON.stringify(next));
      if (!current.includes(offer.id) && config.clickAnalyticsEnabled !== false) trackPublicEvent('favorite', { id: offer.id, label: offer.title, store: offer.store });
      return next;
    });
  }

  async function askAssistant(event) {
    event.preventDefault();

    const message = assistantMessage.trim();

    if (!message) return;

    setAssistantLoading(true);
    const history = assistantMessages.slice(-10).map(({ role, content }) => ({ role, content }));
    setAssistantMessages((current) => [...current, { role: 'user', content: message }]);
    setAssistantMessage('');

    try {
      const result = await api('/assistant/recommend', {
        method: 'POST',
        body: JSON.stringify({
          message,
          history,
          seenProductIds: assistantSeenProductIds
        })
      });

      const products = Array.isArray(result.products) ? result.products : [];
      setAssistantMessages((current) => [...current, {
        role: 'assistant',
        content: result.message || 'Encontrei algumas opções para você.',
        products,
        audiences: Array.isArray(result.audiences) ? result.audiences : []
      }]);
      if (products.length) {
        setAssistantSeenProductIds((current) => [...new Set([...current, ...products.map((product) => product.id)])].slice(-100));
      }
    } catch (error) {
      setAssistantMessages((current) => [...current, {
        role: 'assistant',
        content: error.message || 'Não consegui fazer a recomendação agora.'
      }]);
    } finally {
      setAssistantLoading(false);
    }
  }

  return <div className="site-shell">
    <header className={`topbar ${config.mobileCompactMenu !== false ? 'compact-mobile-nav' : ''}`}>
      <div className="container nav-wrap">
        <Logo name={config.brandName} />
        {config.mobileCompactMenu !== false && <button className="mobile-menu-button" type="button" aria-expanded={mobileMenuOpen} aria-label="Abrir menu" onClick={() => setMobileMenuOpen((current) => !current)}><span></span><span></span><span></span></button>}
        <nav className={mobileMenuOpen ? 'mobile-open' : ''}>
          <a href="#ofertas" onClick={() => setMobileMenuOpen(false)}>Ofertas</a>
          {coupons.length > 0 && <a href="#cupons" onClick={() => setMobileMenuOpen(false)}>Cupons</a>}
          <a href="#grupos" onClick={() => setMobileMenuOpen(false)}>Grupos</a>
          <a href="#como-funciona" onClick={() => setMobileMenuOpen(false)}>Como funciona</a>
          {config.favoritesEnabled !== false && <a href="/favoritos" onClick={() => setMobileMenuOpen(false)}>Favoritos ({favorites.length})</a>}
        </nav>
        <div className="nav-actions"><a className="nav-whatsapp" href={config.whatsappUrl || '#'} target="_blank" rel="noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('whatsapp', { id: 'header', label: 'Grupo no WhatsApp' })}>Grupo no WhatsApp</a></div>
      </div>
    </header>

    <main>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">OFERTAS E CUPONS ATUALIZADOS TODOS OS DIAS</span>
            <h1>{config.heroTitle}</h1>
            <p>{config.heroText}</p>
            <div className="hero-actions"><a className="button light" href="#ofertas">Explorar ofertas</a><a className="button ghost" href={config.whatsappUrl || '#'} target="_blank" rel="noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('whatsapp', { id: 'hero', label: 'Receber no WhatsApp' })}>Receber no WhatsApp</a></div>
            <div className="hero-metrics"><span><strong>{offerTotal}</strong><small>ofertas disponíveis</small></span><span><strong>até {topDiscount}%</strong><small>de desconto</small></span><span><strong>{offerStores.length} lojas</strong><small>em um só lugar</small></span></div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="floating-card card-one"><span>OFERTAS</span><strong>Até {topDiscount}% OFF</strong><small>confirme na loja</small></div>
            <div className="phone"><div className="phone-head"><i></i><b>{config.brandName}</b></div><div className="mini-offer"><div></div><span><b>Oferta selecionada</b><small>Confira na loja</small></span></div><div className="mini-offer"><div></div><span><b>Frete grátis</b><small>Quando informado</small></span></div><div className="phone-cta">VER OFERTA</div></div>
            <div className="floating-card card-two"><span>✨</span><strong>Novas ofertas</strong></div>
          </div>
        </div>
      </section>

      <section className="search-panel container" aria-label="Filtros de ofertas">
        <label className="search-control"><small>O que você procura?</small><span className="search-box"><span aria-hidden="true">⌕</span><input list="offer-suggestions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Busque por produto, marca ou loja" /><datalist id="offer-suggestions">{suggestions.map((item) => <option value={item.title} key={item.slug}>{item.store}</option>)}</datalist></span></label>
        <div className="store-filter"><small>Filtrar por loja</small><div>{stores.map((item) => <button type="button" className={store === item ? 'active' : ''} key={item} onClick={() => setStore(item)}>{item}</button>)}</div></div>
        <label className="sort-filter"><small>Ordenar por</small><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Ordenar ofertas"><option value="smart">Recomendadas</option><option value="discount">Maior desconto</option><option value="recent">Mais recentes</option><option value="price">Menor preço</option></select></label>
        {config.publicAdvancedFiltersEnabled !== false && <div className="advanced-filters"><label>Preço mínimo<input type="number" min="0" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="R$ 0" /></label><label>Preço máximo<input type="number" min="0" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="Sem limite" /></label><label>Desconto mínimo<select value={minDiscount} onChange={(event) => setMinDiscount(event.target.value)}><option value="">Qualquer</option><option value="10">10% OFF</option><option value="20">20% OFF</option><option value="30">30% OFF</option><option value="40">40% OFF</option><option value="50">50% OFF</option></select></label><label className="shipping-filter"><input type="checkbox" checked={freeShipping} onChange={(event) => setFreeShipping(event.target.checked)} /> Frete grátis</label></div>}
        {(query || store !== 'Todas' || category || minPrice || maxPrice || minDiscount || freeShipping) && <button type="button" className="clear-filters" onClick={() => { setQuery(''); setStore('Todas'); setCategory(''); setMinPrice(''); setMaxPrice(''); setMinDiscount(''); setFreeShipping(false); }}>Limpar filtros</button>}
      </section>

      {!!offerCategories.length && <nav className="category-links container" aria-label="Categorias">{offerCategories.slice(0, 12).map((item) => <a className={category === item || category === String(item).toLowerCase().replace(/[^a-z0-9]+/g, '-') ? 'active' : ''} href={`/ofertas/${String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`} key={item}>{item}</a>)}</nav>}

      <section className="offers-section container" id="ofertas">
        <div className="section-heading"><div><span className="eyebrow dark">OPORTUNIDADES SELECIONADAS</span><h2>{favoritesOnly ? 'Seus produtos favoritos' : category ? `Ofertas de ${offerCategories.find((item) => String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') === category) || category}` : store !== 'Todas' ? `Ofertas do ${offerStores.find((item) => String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') === store) || store}` : 'Ofertas que valem a pena'}</h2><p>Compare preços e escolha sua próxima economia.</p></div><span className="results-count"><strong>{favoritesOnly ? visibleOffers.length : offerTotal}</strong> ofertas encontradas</span></div>
        {loading && <p className="notice">Atualizando ofertas…</p>}
        <div className="offer-grid">
          {visibleOffers.map((offer) => <OfferCard offer={offer} config={config} favorite={favoriteSet.has(offer.id)} onFavorite={toggleFavorite} key={offer.id} />)}
        </div>
        {visibleOffers.length < offerTotal && <div className="load-more"><button className="button subtle" type="button" disabled={loadingMore} onClick={() => loadOfferPage({ append: true })}>{loadingMore ? 'Carregando…' : 'Mostrar mais ofertas'}</button><small>Exibindo {visibleOffers.length} de {offerTotal}</small></div>}
        {!loading && !(favoritesOnly ? visibleOffers.length : offerTotal) && <div className="empty"><strong>{favoritesOnly ? 'Você ainda não salvou ofertas' : 'Nenhuma oferta encontrada'}</strong><p>{favoritesOnly ? 'Toque no coração de uma oferta para encontrá-la aqui.' : 'Tente remover algum filtro.'}</p></div>}
      </section>

      {coupons.length > 0 && (
        <section className="coupons-section" id="cupons">
          <div className="container">
            <div className="section-heading">
              <div>
                <span className="eyebrow dark">ECONOMIA EXTRA</span>
                <h2>Cupons para usar hoje</h2>
                <p>Copie o código, confira as regras e ative direto na loja.</p>
              </div>
              <span className="results-count"><strong>{coupons.length}</strong> cupons ativos</span>
            </div>
            <div className="coupon-grid">
              {coupons.map((coupon) => (
                <article className="coupon-card" key={coupon.id}>
                  <div className="coupon-card-top">
                    <span className="coupon-store">{coupon.store || 'Magalu'}</span>
                    <small>{coupon.expiresAt ? `Até ${new Date(coupon.expiresAt).toLocaleDateString('pt-BR')}` : 'Validade não informada'}</small>
                  </div>
                  <h3>{coupon.title}</h3>
                  {coupon.description && <p>{coupon.description}</p>}
                  <div className="coupon-card-actions">
                    {coupon.discountValue > 0 && <strong className="coupon-discount">{coupon.discountType === 'fixed' ? `R$ ${Number(coupon.discountValue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} OFF` : coupon.discountType === 'free-shipping' ? 'FRETE GRÁTIS' : `${coupon.discountValue}% OFF`}</strong>}
                    {coupon.code && <div className="coupon-code"><span>{coupon.code}</span><button type="button" onClick={() => { navigator.clipboard?.writeText(coupon.code); setCouponCopied(coupon.id); window.setTimeout(() => setCouponCopied(''), 1800); }}>{couponCopied === coupon.id ? 'Copiado' : 'Copiar'}</button></div>}
                    <small className="affiliate-label">{config.affiliateDisclosureLabel || 'Publicidade · Link de afiliado'}</small>
                    <a className="button primary full" href={coupon.shortUrl || coupon.link} target="_blank" rel="nofollow sponsored noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('coupon', { id: coupon.id, label: coupon.title, store: coupon.store })}>Ativar cupom <span>↗</span></a>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="how-section" id="como-funciona"><div className="container"><div className="section-heading centered"><div><span className="eyebrow dark">SIMPLES E TRANSPARENTE</span><h2>Economizar ficou mais fácil</h2><p>Nós reunimos as oportunidades. Você decide onde comprar.</p></div></div><div className="how-grid"><article><span>01</span><h3>Buscamos</h3><p>As ofertas são coletadas nas principais plataformas.</p></article><article><span>02</span><h3>Organizamos</h3><p>Você filtra por loja, preço ou desconto sem perder tempo.</p></article><article><span>03</span><h3>Você economiza</h3><p>Abra a oferta na loja oficial e conclua sua compra com segurança.</p></article></div></div></section>
      {(audiences.length > 0 || config.assistantAvailable) && (

        <section
          className={`audience-public-section ${!audiences.length ? 'assistant-only' : ''}`}
          id="grupos"
        >

          <div className="container">

            {audiences.length > 0 && <>

            <div className="section-heading centered">

              <div>
                <span className="eyebrow dark">
                  OFERTAS DO SEU JEITO
                </span>

                <h2>
                  Escolha os grupos que combinam com você
                </h2>

                <p>
                  Entre apenas nos grupos dos assuntos
                  que você quer acompanhar.
                </p>
              </div>

            </div>


            <div className="audience-public-grid">

              {audiences.map((audience) => (

                <article
                  className="audience-public-card"
                  key={audience.code}
                >

                  <span>
                    {audience.code}
                  </span>

                  <h3>
                    {audience.name}
                  </h3>

                  <a
                    className="button primary full"
                    href={audience.whatsappLink}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('group', { id: audience.code, label: audience.name, store: 'WhatsApp' })}
                  >
                    Entrar no grupo
                  </a>

                </article>

              ))}

            </div>

            </>}

            {config.assistantAvailable && (
              <>
                <button
                  className="assistant-floating-button"
                  type="button"
                  onClick={() =>
                    setAssistantOpen(
                      (current) => !current
                    )
                  }
                >
                  🤖
                  <span>Encontrar produto</span>
                </button>

                {assistantOpen && (
                  <section className="assistant-chat">
                    <div className="assistant-chat-head">
                      <div>
                        <strong>
                          Assistente PromoShop
                        </strong>

                        <small>
                          Produtos e grupos certos para você
                        </small>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          setAssistantOpen(false)
                        }
                      >
                        ×
                      </button>
                    </div>

                    <div className="assistant-chat-body" ref={assistantBodyRef} aria-live="polite">
                      {assistantMessages.map((chatMessage, messageIndex) => (
                        <div className={`assistant-message ${chatMessage.role}`} key={`${chatMessage.role}-${messageIndex}`}>
                          <div className={`assistant-bubble ${chatMessage.role}`}>
                            {chatMessage.content}
                          </div>

                          {Array.isArray(chatMessage.products) && chatMessage.products.length > 0 && (
                            <div className="assistant-products">
                              {chatMessage.products.map((product) => (
                                <article className="assistant-product" key={product.id}>
                                  <a className="assistant-product-image" href={`/oferta/${product.publicSlug || product.id}`}>
                                    <img src={product.image} alt={product.title} width="96" height="96" loading="lazy" referrerPolicy="no-referrer" />
                                  </a>
                                  <div>
                                    <small>{product.store}{product.discount > 0 ? ` · ${product.discount}% OFF` : ''}</small>
                                    <h4><a href={`/oferta/${product.publicSlug || product.id}`}>{product.title}</a></h4>
                                    <span>{product.originalPrice > product.price ? <s>{money.format(product.originalPrice)}</s> : null}<strong>{money.format(product.price)}</strong></span>
                                    {product.freeShipping && <em>Frete grátis informado</em>}
                                    <a className="assistant-product-action" href={product.affiliateUrl} target="_blank" rel="nofollow sponsored noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('offer', { id: product.id, label: product.title, store: product.store })}>Ver oferta ↗</a>
                                  </div>
                                </article>
                              ))}
                            </div>
                          )}

                          {Array.isArray(chatMessage.audiences) && chatMessage.audiences.length > 0 && (
                            <div className="assistant-recommendations">
                              <small className="assistant-section-label">Grupo recomendado</small>
                              {chatMessage.audiences.map((audience) => audience.whatsappLink ? (
                                <a key={audience.code} href={audience.whatsappLink} target="_blank" rel="noreferrer" className="assistant-group" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('group', { id: audience.code, label: audience.name, store: 'WhatsApp' })}>
                                  <span><small>{audience.code}</small><strong>{audience.name}</strong></span><b>Entrar →</b>
                                </a>
                              ) : (
                                <div className="assistant-group no-link" key={audience.code}><span><small>{audience.code}</small><strong>{audience.name}</strong></span></div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}

                      {assistantLoading && <div className="assistant-bubble assistant assistant-thinking"><i></i><i></i><i></i><span className="visually-hidden">Procurando ofertas</span></div>}
                    </div>

                    <form
                      className="assistant-chat-form"
                      onSubmit={askAssistant}
                    >
                      <textarea
                        value={assistantMessage}
                        onChange={(event) =>
                          setAssistantMessage(
                            event.target.value
                          )
                        }
                        placeholder="Ex.: Quero um notebook para estudar até R$ 3.000"
                        rows={2}
                        maxLength={1000}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' || event.shiftKey) return;
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }}
                      />

                      <button
                        className="button primary"
                        type="submit"
                        disabled={
                          assistantLoading ||
                          !assistantMessage.trim()
                        }
                      >
                        {assistantLoading
                          ? 'Buscando…'
                          : 'Enviar'}
                      </button>
                    </form>
                  </section>
                )}
              </>
            )}

          </div>

        </section>

      )}
      <section className="whatsapp-section" id="grupo"><div className="container whatsapp-card"><div><span className="whatsapp-icon">◉</span><span><small>OFERTAS EM PRIMEIRA MÃO</small><h2>As melhores promoções chegam até você</h2><p>Entre no grupo do WhatsApp e receba os alertas sem precisar ficar procurando.</p></span></div><a className="button whatsapp" href={config.whatsappUrl || '#'} target="_blank" rel="noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('whatsapp', { id: 'footer-cta', label: 'Quero receber ofertas' })}>Quero receber ofertas</a></div></section>
    </main>

    <SiteFooter config={config} />
    <PrivacyConsent policyVersion={config.legalPolicyVersion} />
  </div>;
}

function ProductDetail({ slug }) {
  const [config, setConfig] = useState(fallbackConfig);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [favorites, setFavorites] = useState(readFavorites);
  usePublicAnalytics();

  useEffect(() => {
    Promise.all([api('/config/public'), api(`/offer/${encodeURIComponent(slug)}`)])
      .then(([nextConfig, offerData]) => { setConfig({ ...fallbackConfig, ...nextConfig }); setData(offerData); })
      .catch((nextError) => setError(nextError.message || 'Oferta não encontrada.'));
  }, [slug]);

  function toggleFavorite(offer) {
    setFavorites((current) => {
      const next = current.includes(offer.id) ? current.filter((id) => id !== offer.id) : [...current, offer.id];
      localStorage.setItem(favoritesStorageKey, JSON.stringify(next));
      return next;
    });
  }

  if (error) return <div className="site-shell"><header className="topbar"><div className="container nav-wrap"><Logo name={config.brandName} /></div></header><main className="product-page container"><div className="empty"><strong>{error}</strong><p>Esta oferta pode ter expirado ou sido removida.</p><a className="button primary" href="/">Ver ofertas atuais</a></div></main><SiteFooter config={config} /></div>;
  if (!data?.offer) return <div className="site-shell"><main className="product-page container"><p className="notice">Carregando oferta…</p></main></div>;
  const { offer, comparisons = [], related = [] } = data;
  return <div className="site-shell">
    <header className="topbar"><div className="container nav-wrap"><Logo name={config.brandName} /><nav><a href="/">Ofertas</a><a href="/favoritos">Favoritos ({favorites.length})</a></nav></div></header>
    <main className="product-page container">
      <nav className="breadcrumbs" aria-label="Navegação"><a href="/">Início</a><span>›</span><a href={`/ofertas/${String(offer.category || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{offer.category}</a><span>›</span><span>{offer.title}</span></nav>
      <section className="product-hero"><div className="product-image"><img src={offer.image} alt={offer.title} referrerPolicy="no-referrer" /></div><div className="product-copy"><span className="eyebrow dark">{offer.store} · {offer.category}</span><h1>{offer.title}</h1>{discount(offer) > 0 && <span className="product-discount">{discount(offer)}% de desconto</span>}<div className="product-price"><s>{offer.originalPrice > offer.price ? money.format(offer.originalPrice) : ''}</s><strong>{money.format(offer.price)}</strong></div>{offer.freeShipping && <span className="shipping">Frete grátis informado pela loja</span>}<p>Confira preço, estoque, frete e condições diretamente na loja antes de concluir a compra.</p><small className="affiliate-label">{config.affiliateDisclosureLabel || 'Publicidade · Link de afiliado'}</small><div className="product-actions"><a className="button primary" href={offer.affiliateUrl} target="_blank" rel="nofollow sponsored noreferrer" onClick={() => config.clickAnalyticsEnabled !== false && trackPublicEvent('offer', { id: offer.id, label: offer.title, store: offer.store })}>Ver oferta no {offer.store} ↗</a>{config.favoritesEnabled !== false && <button className="button subtle" type="button" onClick={() => toggleFavorite(offer)}>{favorites.includes(offer.id) ? '♥ Salvo' : '♡ Salvar'}</button>}</div></div></section>
      {!!comparisons.length && <section className="product-related"><div className="section-heading"><div><span className="eyebrow dark">COMPARE</span><h2>Ofertas parecidas</h2><p>Compare valores antes de escolher.</p></div></div><div className="offer-grid">{comparisons.map((item) => <OfferCard offer={item} config={config} favorite={favorites.includes(item.id)} onFavorite={toggleFavorite} key={item.id} />)}</div></section>}
      {!!related.length && <section className="product-related"><div className="section-heading"><div><span className="eyebrow dark">VOCÊ TAMBÉM PODE GOSTAR</span><h2>Mais ofertas de {offer.category}</h2></div></div><div className="offer-grid">{related.map((item) => <OfferCard offer={item} config={config} favorite={favorites.includes(item.id)} onFavorite={toggleFavorite} key={item.id} />)}</div></section>}
    </main><SiteFooter config={config} /><PrivacyConsent policyVersion={config.legalPolicyVersion} />
  </div>;
}

function SiteFooter({ config = fallbackConfig }) {
  const brandName = config.brandName || fallbackConfig.brandName;
  const year = new Date().getFullYear();

  return <footer className="site-footer">
    <div className="container footer-grid footer-grid-rich">
      <div className="footer-brand">
        <Logo name={brandName} />
        <p>{config.disclosure || fallbackConfig.disclosure}</p>
        <small>Ofertas selecionadas para ajudar você a comprar melhor.</small>
      </div>
      <div className="footer-column">
        <h3>PromoShop</h3>
        <a href="/sobre">Sobre nós</a>
        <a href="/#ofertas">Ofertas</a>
        <a href="/#cupons">Cupons</a>
        <a href="/#grupos">Grupos do WhatsApp</a>
      </div>
      <div className="footer-column">
        <h3>Informações</h3>
        <a href="/termos-de-uso">Termos de uso</a>
        <a href="/privacidade">Privacidade</a>
        <button type="button" className="footer-privacy-button" onClick={() => window.dispatchEvent(new Event(privacyOpenEvent))}>Preferências de privacidade</button>
      </div>
      <div className="footer-column footer-contact">
        <h3>Contato</h3>
        <a href="/contato">Fale conosco ↗</a>
      </div>
    </div>
    <div className="container footer-bottom"><span>© {year} {brandName}. Todos os direitos reservados.</span><span>Links de afiliado podem gerar comissão, sem custo adicional.</span></div>
  </footer>;
}

const publicInfoPages = {
  '/sobre': {
    eyebrow: 'SOBRE O PROMOSHOP',
    title: 'Ofertas boas, encontradas com mais clareza.',
    intro: 'O PromoShop reúne ofertas e cupons de diferentes lojas para você comparar oportunidades e decidir onde comprar.',
    updatedAt: '23 de agosto de 2026',
    sections: [
      { title: 'O que fazemos', paragraphs: ['Somos uma vitrine independente de curadoria de ofertas. Organizamos produtos, preços, descontos e cupons em um só lugar para reduzir o tempo gasto na busca por oportunidades.', 'As informações podem ser coletadas automaticamente nas plataformas parceiras e organizadas por critérios do PromoShop. Sempre confirme preço, estoque, frete, validade e demais condições diretamente na loja.'] },
      { title: 'Não somos uma loja', paragraphs: ['O PromoShop não vende produtos, não recebe pagamentos, não entrega mercadorias e não administra trocas, garantias ou reembolsos. Ao clicar em uma oferta, você é direcionado à loja responsável pela venda e pelo atendimento.'] },
      { title: 'Programas de afiliados', paragraphs: ['Participamos atualmente dos programas de afiliados do Mercado Livre, Shopee, AliExpress e Magalu. Podemos receber uma comissão quando uma compra é realizada por nossos links, sem custo adicional para você. As ofertas e cupons identificam essa relação de forma discreta.'] },
      { title: 'Responsável pelo projeto', paragraphs: ['O PromoShop é mantido por Jhonata Ferreira de Araujo, pessoa física, em Brasília/DF. Dúvidas gerais ou de privacidade podem ser enviadas para contatopromoshop.site@gmail.com ou pelo formulário de contato.'] }
    ]
  },
  '/contato': {
    eyebrow: 'FALE CONOSCO',
    title: 'Estamos aqui para ajudar.',
    intro: 'Encontrou um problema, quer sugerir uma loja ou exercer um direito de privacidade? Envie sua mensagem pelo formulário.',
    updatedAt: '23 de agosto de 2026',
    sections: [
      { title: 'Dúvidas sobre ofertas', paragraphs: ['Como os preços e as regras pertencem à loja de origem, confirme sempre as condições diretamente no site antes de finalizar a compra. Se você encontrar um link quebrado ou uma informação desatualizada, avise-nos para que possamos revisar.'] },
      { title: 'Contato direto', paragraphs: ['Você pode falar com Jhonata Ferreira de Araujo pelo formulário abaixo. A resposta inicial será enviada ao e-mail informado em até 5 dias úteis. Solicitações complexas ou sujeitas a prazo legal podem exigir tempo adicional, que será informado quando necessário.'], contactForm: true },
      { title: 'Privacidade, parcerias e sugestões', paragraphs: ['Use o assunto “Privacidade e dados pessoais” para solicitar acesso, correção, eliminação ou outras providências previstas na legislação. Também recebemos sugestões de lojas, cupons e categorias; o envio não garante publicação.'] }
    ]
  },
  '/termos-de-uso': {
    eyebrow: 'TERMOS DE USO',
    title: 'Uso simples, transparente e responsável.',
    intro: 'Ao acessar o PromoShop, você concorda com as condições abaixo. Leia com atenção antes de utilizar o site.',
    updatedAt: '23 de agosto de 2026',
    sections: [
      { title: '1. Responsável e finalidade', paragraphs: ['O PromoShop é mantido por Jhonata Ferreira de Araujo, pessoa física, em Brasília/DF. O serviço divulga e organiza ofertas, cupons e links para lojas de terceiros.'] },
      { title: '2. Intermediação e responsabilidades', paragraphs: ['O PromoShop não recebe pagamentos, não vende, não entrega e não participa do contrato de compra e venda. Pagamento, estoque, entrega, garantia, troca, devolução, suporte e nota fiscal são de responsabilidade exclusiva da loja e do consumidor, conforme as regras e a legislação aplicáveis.', 'Uma eventual divergência deve ser confirmada e tratada diretamente com a loja. O PromoShop pode ajudar a revisar ou remover uma divulgação, mas não substitui o atendimento do vendedor.'] },
      { title: '3. Preços, cupons e disponibilidade', paragraphs: ['As informações refletem os dados disponíveis no momento da coleta ou publicação e podem mudar sem aviso. Não garantimos menor preço histórico, disponibilidade, frete grátis ou manutenção do desconto.', 'Quando a loja não informar a validade de um cupom, ele será identificado como “validade não informada”. A condição válida é sempre aquela exibida pela loja antes da conclusão da compra.'] },
      { title: '4. Links de afiliados', paragraphs: ['Participamos dos programas de afiliados do Mercado Livre, Shopee, AliExpress e Magalu. O PromoShop poderá receber comissão por compras qualificadas iniciadas por um link de afiliado, sem custo adicional para você. Essa relação é identificada nas ofertas e nos cupons.'] },
      { title: '5. WhatsApp', paragraphs: ['As publicações são realizadas em grupos e canais nos quais as pessoas entraram voluntariamente. A participação pode ser encerrada a qualquer momento pelos recursos do próprio WhatsApp.', 'O uso do WhatsApp também está sujeito aos termos e às configurações da plataforma. Conforme o tipo de grupo e as configurações escolhidas, outras pessoas poderão visualizar informações do perfil ou número do participante.'] },
      { title: '6. Público e menores de idade', paragraphs: ['O site apresenta promoções de uso geral e não é direcionado especificamente a crianças. Menores devem navegar e enviar solicitações com acompanhamento ou autorização de responsável legal, especialmente quando houver fornecimento de dados no formulário.'] },
      { title: '7. Uso adequado', paragraphs: ['É proibido tentar comprometer a segurança ou a disponibilidade do site, acessar áreas restritas sem autorização, usar automação abusiva, praticar fraude ou reproduzir conteúdo de forma que viole direitos do PromoShop ou de terceiros.'] },
      { title: '8. Serviços e marcas de terceiros', paragraphs: ['Links externos conduzem a ambientes controlados por terceiros e sujeitos aos próprios termos e políticas. Marcas, nomes, imagens e sinais distintivos pertencem aos respectivos titulares e são utilizados apenas para identificar ofertas e lojas.'] },
      { title: '9. Propriedade intelectual', paragraphs: ['A identidade visual, a organização, os textos próprios e os componentes do PromoShop são protegidos pela legislação aplicável. O acesso ao site não transfere direitos de propriedade intelectual ao usuário.'] },
      { title: '10. Alterações, contato e legislação', paragraphs: ['Estes termos podem ser atualizados para refletir mudanças no serviço ou na legislação. A versão e a data vigentes ficam indicadas nesta página. Dúvidas podem ser enviadas pelo Fale Conosco.', 'Aplicam-se as leis da República Federativa do Brasil, preservados os direitos do consumidor e o foro legalmente competente.'] }
    ]
  },
  '/privacidade': {
    eyebrow: 'PRIVACIDADE',
    title: 'Sua navegação com o mínimo de dados.',
    intro: 'Esta página explica, em linguagem simples, quais informações o PromoShop utiliza para funcionar e melhorar o serviço.',
    updatedAt: '23 de agosto de 2026',
    sections: [
      { title: '1. Controlador e contato', paragraphs: ['O responsável pelo tratamento relacionado ao PromoShop é Jhonata Ferreira de Araujo, pessoa física, localizado em Brasília/DF. O canal para assuntos de privacidade é contatopromoshop.site@gmail.com ou o formulário Fale Conosco.', 'Buscamos enviar uma resposta inicial em até 5 dias úteis, sem prejuízo de prazos específicos previstos em lei.'] },
      { title: '2. Dados tratados', paragraphs: ['Medição opcional: somente após sua autorização, criamos identificadores aleatórios no navegador para contar visitantes, sessões, páginas vistas e cliques em ofertas, cupons, favoritos, grupos e botões. Registramos totais agregados, tipo do clique, loja e nome resumido do destino; não guardamos nesse controle o endereço completo do link. Os identificadores não contêm nome, e-mail, telefone ou endereço IP e não utilizamos impressão digital do dispositivo.', 'Favoritos: os identificadores das ofertas salvas ficam apenas no armazenamento local do seu navegador e não são sincronizados com uma conta. Você pode removê-los pelo próprio site ou apagando os dados do navegador.', 'Contato: quando você envia o formulário, tratamos nome, e-mail, assunto e mensagem. O endereço IP pode ser usado temporariamente em memória para limitar abuso, mas não é armazenado junto à mensagem nem exibido na caixa de entrada.', 'O servidor também pode gerar registros técnicos de segurança e funcionamento. Serviços externos e lojas podem receber dados técnicos normais da conexão quando o navegador carrega um recurso ou quando você clica em um link.'] },
      { title: '3. Finalidades e bases legais', paragraphs: ['A medição de audiência e de interação ajuda a entender quais páginas, lojas, ofertas e cupons despertam interesse. Ela é realizada com consentimento e pode ser rejeitada ou revogada sem perda de funcionalidade. Guardamos apenas um comprovante anônimo da escolha, com data, versão desta política e decisão, sem nome ou IP.', 'Os dados do contato são usados para receber, organizar e responder à solicitação, com base em procedimentos solicitados pelo titular e, conforme o caso, legítimo interesse no atendimento e na segurança. Também poderemos conservar informações para cumprir obrigação legal ou exercer direitos em processo.'] },
      { title: '4. Compartilhamento e operadores', paragraphs: ['Usamos a Render para hospedagem, a Brevo para entrega e recebimento de e-mails e o Google Search Console para consultar relatórios agregados de desempenho na pesquisa, como cliques, impressões, páginas e termos buscados. Os links e conteúdos também podem envolver Mercado Livre, Shopee, AliExpress, Magalu e WhatsApp. Esses provedores podem tratar dados conforme seus próprios termos e políticas.', 'Não vendemos dados pessoais, não comercializamos listas de contatos e não usamos o formulário para newsletter ou publicidade. O contato é utilizado apenas para responder e acompanhar a conversa.'] },
      { title: '5. Transferências internacionais', paragraphs: ['Alguns provedores de hospedagem, e-mail, mensageria e programas de afiliados podem processar dados fora do Brasil. Nesses casos, buscamos utilizar serviços reconhecidos e mecanismos contratuais e de segurança compatíveis com a legislação aplicável.'] },
      { title: '6. Retenção e eliminação', paragraphs: ['Mensagens e respostas do Fale Conosco são mantidas por até 12 meses após a última interação, salvo necessidade legal de conservação por prazo maior. Identificadores de audiência podem ser mantidos por até 365 dias e resumos diários por até 120 dias.', 'Comprovantes anônimos de consentimento podem ser mantidos por até 5 anos para demonstrar a escolha registrada. Quando a pessoa rejeita ou revoga a medição, o identificador individual conhecido por este navegador é removido dos registros ativos; totais estatísticos já agregados não permitem reidentificação e podem permanecer.'] },
      { title: '7. Seus direitos', paragraphs: ['Você pode solicitar confirmação de tratamento, acesso, correção, anonimização, bloqueio, eliminação, portabilidade quando aplicável, informação sobre compartilhamento, revisão, oposição e revogação do consentimento. Poderemos pedir informações mínimas para confirmar a legitimidade da solicitação.', 'Para mudar a medição, use “Preferências de privacidade” no rodapé. Para outras solicitações, use o Fale Conosco com o assunto “Privacidade e dados pessoais”.'] },
      { title: '8. Crianças e adolescentes', paragraphs: ['O PromoShop é um site de promoções de uso geral e não é direcionado especificamente a crianças. Não buscamos criar perfis de menores. Solicitações que envolvam dados de menores devem ser realizadas com acompanhamento ou autorização de responsável legal.'] },
      { title: '9. Segurança, cópias e incidentes', paragraphs: ['Adotamos controles de acesso, autenticação administrativa, limitação contra abuso e outras medidas razoáveis para proteger os dados. Cópias técnicas do serviço podem conter dados ainda dentro dos prazos de retenção e seguem os controles do provedor de hospedagem. O backup operacional baixado pelo painel exclui mensagens, comprovantes de consentimento, identificadores de audiência, senhas, chaves e sessão do WhatsApp.', 'Nenhum sistema é totalmente livre de riscos; caso ocorra incidente relevante, serão adotadas as providências legais e técnicas cabíveis, inclusive comunicação quando exigida.'] },
      { title: '10. Atualizações e contato', paragraphs: ['Esta política pode ser atualizada quando houver mudanças no serviço, nos fornecedores ou na legislação. A versão vigente será publicada nesta página com a data da atualização.'] , contact: true }
    ]
  }
};

function legalText(text, config = fallbackConfig) {
  const replacements = [
    ['Jhonata Ferreira de Araujo', config.legalResponsibleName],
    ['pessoa física', config.legalResponsibleType],
    ['Brasília/DF', config.legalCityState],
    ['contatopromoshop.site@gmail.com', config.legalPrivacyEmail || config.contactEmail],
    ['Mercado Livre, Shopee, AliExpress e Magalu', config.legalAffiliatePrograms],
    ['até 5 dias úteis', `até ${Number(config.legalResponseBusinessDays || 5)} dias úteis`],
    ['até 12 meses', `até ${Number(config.legalContactRetentionMonths || config.contactRetentionMonths || 12)} meses`],
    ['até 5 anos', `até ${Number(config.legalConsentRetentionYears || config.consentReceiptRetentionYears || 5)} anos`],
    ['até 365 dias', `até ${Number(config.analyticsVisitorRetentionDays || 365)} dias`],
    ['até 120 dias', `até ${Number(config.analyticsDailyRetentionDays || 120)} dias`]
  ];

  return replacements.reduce((result, [from, to]) => (
    to ? result.replaceAll(from, String(to)) : result
  ), String(text || ''));
}

function legalVersionLabel(version) {
  const datePart = String(version || '').slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
    ? new Date(`${datePart}T12:00:00-03:00`)
    : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    : String(version || 'não informada');
}

function ContactForm({ contactEmail, responseBusinessDays = 5 }) {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '', website: '' });
  const [status, setStatus] = useState({ type: '', text: '' });
  const [sending, setSending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSending(true);
    setStatus({ type: '', text: '' });

    try {
      await api('/contact', {
        method: 'POST',
        body: JSON.stringify(form)
      });
      setForm({ name: '', email: '', subject: '', message: '', website: '' });
      setStatus({ type: 'success', text: 'Mensagem enviada. Obrigado por entrar em contato!' });
    } catch (error) {
      setStatus({ type: 'error', text: error.message || 'Não foi possível enviar agora. Tente novamente.' });
    } finally {
      setSending(false);
    }
  }

  return <form className="contact-form" onSubmit={submit}>
    <div className="contact-form-grid">
      <label>Nome<input required minLength={2} maxLength={80} autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Como podemos chamar você?" /></label>
      <label>E-mail<input required type="email" maxLength={200} autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="voce@exemplo.com" /></label>
    </div>
    <label>Assunto<select required value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })}><option value="">Selecione o assunto</option><option>Dúvida sobre oferta</option><option>Link ou preço desatualizado</option><option>Privacidade e dados pessoais</option><option>Parceria ou sugestão</option><option>Outro</option></select></label>
    <label>Mensagem<textarea required minLength={10} maxLength={4000} rows={6} value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} placeholder="Conte como podemos ajudar…" /></label>
    <label className="contact-honeypot" aria-hidden="true">Site<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} /></label>
    <p className="contact-privacy-note">Ao enviar, você concorda com o uso dos dados para responder e acompanhar esta solicitação, conforme a <a href="/privacidade">Política de Privacidade</a>. Menores devem usar o formulário com acompanhamento ou autorização de responsável.</p>
    <div className="contact-form-footer"><button className="button primary" type="submit" disabled={sending}>{sending ? 'Enviando…' : 'Enviar mensagem'}</button><span>Resposta inicial em até {Number(responseBusinessDays || 5)} dias úteis pelo e-mail informado.</span></div>
    {status.text && <p className={`contact-status ${status.type}`} role="status">{status.text}</p>}
    <div className="contact-form-alternative">{contactEmail && <span>Ou escreva para <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</span>}</div>
  </form>;
}

function InfoPage({ page }) {
  const [config, setConfig] = useState(fallbackConfig);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const info = publicInfoPages[page] || publicInfoPages['/sobre'];
  const contactEmail = String(config.contactEmail || '').trim();
  const whatsappUrl = String(config.whatsappUrl || '').trim();
  const customTextKey = { '/sobre': 'legalAboutCustomText', '/contato': 'legalContactCustomText', '/termos-de-uso': 'legalTermsCustomText', '/privacidade': 'legalPrivacyCustomText' }[page];
  const customText = String(config[customTextKey] || '').trim();

  usePublicAnalytics();

  useEffect(() => {
    api('/config/public')
      .then((configData) => setConfig({ ...fallbackConfig, ...configData }))
      .catch(() => { });
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--primary', config.primaryColor || fallbackConfig.primaryColor);
    document.title = `${info.title} — ${config.brandName || fallbackConfig.brandName}`;
  }, [config, info.title]);

  return <div className="site-shell info-shell">
    <header className={`topbar ${config.mobileCompactMenu !== false ? 'compact-mobile-nav' : ''}`}>
      <div className="container nav-wrap">
        <Logo name={config.brandName || fallbackConfig.brandName} />
        {config.mobileCompactMenu !== false && <button className="mobile-menu-button" type="button" aria-expanded={mobileMenuOpen} aria-label="Abrir menu" onClick={() => setMobileMenuOpen((current) => !current)}><span></span><span></span><span></span></button>}
        <nav className={mobileMenuOpen ? 'mobile-open' : ''}><a href="/#ofertas" onClick={() => setMobileMenuOpen(false)}>Ofertas</a><a href="/#cupons" onClick={() => setMobileMenuOpen(false)}>Cupons</a><a href="/#grupos" onClick={() => setMobileMenuOpen(false)}>Grupos</a><a href="/#como-funciona" onClick={() => setMobileMenuOpen(false)}>Como funciona</a></nav>
        <div className="nav-actions"><a className="nav-whatsapp" href={whatsappUrl || '#'} target="_blank" rel="noreferrer">Grupo no WhatsApp</a></div>
      </div>
    </header>
    <main className="info-main">
      <section className="info-hero"><div className="container"><span className="eyebrow">{info.eyebrow}</span><h1>{info.title}</h1><p>{info.intro}</p><small className="info-updated">Versão vigente · Atualizada em {legalVersionLabel(config.legalPolicyVersion)}</small></div></section>
      <article className="container info-content">
        {customText && <aside className="info-custom-note"><strong>Informação adicional</strong>{customText.split(/\n{2,}/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</aside>}
        {info.sections.map((section) => <section className="info-section" key={section.title}><h2>{section.title}</h2>{section.paragraphs.map((paragraph) => <p key={paragraph}>{legalText(paragraph, config)}</p>)}{section.contactForm && <ContactForm contactEmail={contactEmail} responseBusinessDays={config.legalResponseBusinessDays} />}{section.contact && <div className="info-contact-actions"><a className="button primary" href="/contato">Ir para Fale Conosco ↗</a></div>}</section>)}
        <aside className="info-disclosure"><strong>Transparência do PromoShop</strong><p>Alguns links podem ser de afiliado. Se uma compra for realizada após o clique, podemos receber uma comissão sem custo adicional para você.</p></aside>
      </article>
    </main>
    <SiteFooter config={config} />
    <PrivacyConsent policyVersion={config.legalPolicyVersion} />
  </div>;
}

function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setError('');
    try { const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(form) }); localStorage.setItem('promoshop_token', result.token); onLogin(result.token); }
    catch (err) { setError(err.message); }
  }
  return <div className="login-page"><form className="login-card" onSubmit={submit}><Logo name="PromoShop" /><div><span className="eyebrow dark">ÁREA RESTRITA</span><h1>Painel administrativo</h1><p>Entre para gerenciar ofertas e automações.</p></div><label>Usuário<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label><label>Senha<input required type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>{error && <p className="error">{error}</p>}<button className="button primary full">Entrar</button><a className="back-link" href="/">← Voltar para o site</a></form></div>;
}

const defaultNewOffer = { title: '', store: 'Mercado Livre', category: 'Eletrônicos', price: '', originalPrice: '', image: '', affiliateUrl: '', freeShipping: false, featured: true, status: 'active' };
const defaultCoupon = { title: '', store: 'Magalu', code: '', description: '', discountType: 'percent', discountValue: '', minPurchase: '', expiresAt: '', link: 'https://www.magazinevoce.com.br/magazinepromoshopsite/', image: '', featured: true, active: true, targetAudienceCodes: ['G01'] };

function offerFormFromOffer(offer) {
  return {
    ...defaultNewOffer,
    title: offer?.title || '',
    store: offer?.store || 'Outra',
    category: offer?.category || '',
    price: offer?.price ?? '',
    originalPrice: offer?.originalPrice ?? '',
    image: offer?.image || '',
    affiliateUrl: offer?.affiliateUrl || offer?.productUrl || '',
    freeShipping: Boolean(offer?.freeShipping),
    featured: Boolean(offer?.featured),
    status: offer?.status || 'active'
  };
}

function KeywordEditor({ label, value, onChange, placeholder, help }) {
  const [draft, setDraft] = useState('');
  const words = Array.isArray(value) ? value : [];

  function addWords(rawValue = draft) {
    const additions = String(rawValue || '')
      .split(/[,;\n]+/)
      .map((word) => word.trim())
      .filter(Boolean);
    if (!additions.length) return;

    const next = [];
    const seen = new Set();
    for (const word of [...words, ...additions]) {
      const clean = String(word).trim().slice(0, 80);
      const key = clean.toLocaleLowerCase('pt-BR');
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      next.push(clean);
      if (next.length >= 200) break;
    }
    onChange(next);
    setDraft('');
  }

  function removeWord(index) {
    onChange(words.filter((_, wordIndex) => wordIndex !== index));
  }

  return <div className="keyword-editor">
    <span className="keyword-editor-label">{label}</span>
    <div className="keyword-tags">
      {words.map((word, index) => <span className="keyword-tag" key={`${word}-${index}`}>{word}<button type="button" onClick={() => removeWord(index)} aria-label={`Remover ${word}`}>×</button></span>)}
      {!words.length && <small>Nenhuma palavra cadastrada.</small>}
    </div>
    <div className="keyword-entry">
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ',') return;
          event.preventDefault();
          addWords();
        }}
        placeholder={placeholder}
      />
      <button className="button subtle" type="button" onClick={() => addWords()}>Adicionar</button>
    </div>
    <small>{help}</small>
  </div>;
}

function couponDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function couponFormFromCoupon(coupon) {
  return {
    ...defaultCoupon,
    ...coupon,
    discountValue: coupon.discountValue ?? '',
    minPurchase: coupon.minPurchase ?? '',
    expiresAt: couponDateTimeLocal(coupon.expiresAt),
    targetAudienceCodes: Array.isArray(coupon.targetAudienceCodes) && coupon.targetAudienceCodes.length
      ? coupon.targetAudienceCodes.map((code) => String(code).toUpperCase())
      : []
  };
}

function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem('promoshop_token'));
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState({ offers: [], queue: [], config: fallbackConfig, logs: [], analytics: {}, meta: { whatsapp: {} }, secrets: {} });
  const [newOffer, setNewOffer] = useState(defaultNewOffer);
  const [editingOfferId, setEditingOfferId] = useState('');
  const [couponForm, setCouponForm] = useState(defaultCoupon);
  const [editingCouponId, setEditingCouponId] = useState('');
  const [secretForm, setSecretForm] = useState({
    adminUser: 'admin',
    adminPassword: '',

    mercadoLivreClientId: '',
    mercadoLivreClientSecret: '',
    mercadoLivreAccessToken: '',

    mercadoLivreAffiliateCookie: '',
    mercadoLivreAffiliateCsrfToken: '',
    mercadoLivreAffiliateTag: 'promoshop',

    shopeeAppId: '',
    shopeeAppSecret: '',

    aliexpressAppKey: '',
    aliexpressAppSecret: '',
    aliexpressAppSignature: '',

    magaluAffiliateId: '',
    magaluApiKey: '',
    netshoesAffiliateId: '',
    netshoesApiKey: '',
    googleSearchConsoleClientId: '',
    googleSearchConsoleClientSecret: '',

    aiApiKey: '',
    geminiApiKey: '',
    openaiApiKey: ''
  });
  const [phoneNumber, setPhoneNumber] = useState('55');
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState(null);
  const [aiPreview, setAiPreview] = useState('');
  const [adminOfferQuery, setAdminOfferQuery] = useState('');
  const [adminOfferStore, setAdminOfferStore] = useState('Todas');
  const [reviewFilter, setReviewFilter] = useState('attention');
  const [reviewSelected, setReviewSelected] = useState([]);
  const [searchConsoleData, setSearchConsoleData] = useState(null);
  const [productSearch, setProductSearch] = useState({
    query: '',
    stores: ['mercadolivre', 'shopee', 'magalu'],
    limit: 10,
    strict: true
  });

  const [productSearchResults, setProductSearchResults] = useState([]);
  const [productSearchErrors, setProductSearchErrors] = useState([]);
  const [productSearchStoreCounts, setProductSearchStoreCounts] = useState({});
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  const [magaluStoreUrl, setMagaluStoreUrl] = useState('');
  const backupInputRef = useRef(null);
  function updateAudience(index, changes) {
    setData((current) => {
      const audiences = Array.isArray(current.config.whatsappAudiences)
        ? [...current.config.whatsappAudiences]
        : [];
      audiences[index] = { ...audiences[index], ...changes };
      return {
        ...current,
        config: { ...current.config, whatsappAudiences: audiences }
      };
    });
  }

  function addAudience() {
    const audiences = Array.isArray(
      data.config.whatsappAudiences
    )
      ? data.config.whatsappAudiences
      : [];

    const highestNumber = audiences.reduce(
      (highest, audience) => {
        const match = String(audience.code || '')
          .match(/^G(\d+)$/i);

        if (!match) return highest;

        return Math.max(
          highest,
          Number(match[1])
        );
      },
      0
    );

    const code =
      `G${String(highestNumber + 1).padStart(2, '0')}`;

    setData({
      ...data,
      config: {
        ...data.config,

        whatsappAudiences: [
          ...audiences,
          {
            code,
            name: '',
            whatsappLink: '',
            keywords: [],
            enabled: true
          }
        ]
      }
    });
  }

  function removeAudience(index) {
    const audiences = Array.isArray(
      data.config.whatsappAudiences
    )
      ? data.config.whatsappAudiences
      : [];

    const audience = audiences[index];

    if (
      audience?.code === 'G01' ||
      audience?.code === 'G10'
    ) {
      setMessage(
        `${audience.code} é um grupo padrão e não pode ser removido. Você pode desativá-lo.`
      );

      return;
    }

    setData({
      ...data,
      config: {
        ...data.config,

        whatsappAudiences:
          audiences.filter(
            (_, audienceIndex) =>
              audienceIndex !== index
          )
      }
    });
  }
  const authApi = (path, options = {}) => api(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });

  async function load({ preserveConfig = false } = {}) {
    try {
      const result = await authApi('/admin/dashboard');
      setData((current) => preserveConfig ? { ...result, config: current.config } : result);
      if (!preserveConfig) {
        setSecretForm((current) => ({
          ...current,

          adminUser:
            result.secrets?.adminUser ||
            current.adminUser,

          mercadoLivreClientId:
            result.secrets?.mercadoLivreClientId ||
            current.mercadoLivreClientId,

          mercadoLivreAffiliateTag:
            result.secrets?.mercadoLivreAffiliateTag ||
            current.mercadoLivreAffiliateTag ||
            'promoshop',

          shopeeAppId:
            result.secrets?.shopeeAppId ||
            current.shopeeAppId,

          aliexpressAppKey:
            result.secrets?.aliexpressAppKey ||
            current.aliexpressAppKey,

          magaluAffiliateId:
            result.secrets?.magaluAffiliateId ||
            current.magaluAffiliateId,

          netshoesAffiliateId:
            result.secrets?.netshoesAffiliateId ||
            current.netshoesAffiliateId
        }));
      }
    }
    catch (error) {
      if (error.status === 401) {
        localStorage.removeItem('promoshop_token');
        setToken(null);
      }
    }
  }
  useEffect(() => { if (token) load(); }, [token]);
  useEffect(() => {
    if (!message) return undefined;
    const timeout = window.setTimeout(() => setMessage(''), 6500);
    return () => window.clearTimeout(timeout);
  }, [message]);
  useEffect(() => {
    if (!dialog) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setDialog(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [dialog]);
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('mercadolivre');
    if (!status) return;
    setTab('sources');
    setMessage(status === 'connected' ? 'Mercado Livre conectado com sucesso.' : status === 'cancelled' ? 'A autorização do Mercado Livre foi cancelada.' : 'Não foi possível concluir a autorização. Confira o log do painel.');
    window.history.replaceState({}, '', '/admin');
  }, []);
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('searchconsole');
    if (!status) return;
    setTab('analytics');
    setMessage(status === 'connected' ? 'Google Search Console conectado com sucesso.' : 'Não foi possível conectar o Search Console. Confira as credenciais e o log.');
    window.history.replaceState({}, '', '/admin');
  }, []);
  useEffect(() => {
    if (!token || tab !== 'whatsapp') return undefined;
    const interval = window.setInterval(() => load({ preserveConfig: true }), 4000);
    return () => window.clearInterval(interval);
  }, [token, tab]);
  useEffect(() => {
    if (!token || tab !== 'inbox') return undefined;
    const interval = window.setInterval(() => load({ preserveConfig: true }), 15000);
    return () => window.clearInterval(interval);
  }, [token, tab]);
  useEffect(() => {
    if (token && tab === 'analytics' && data.secrets?.googleSearchConsoleConnected && !searchConsoleData) loadSearchConsole();
  }, [token, tab, data.secrets?.googleSearchConsoleConnected]);
  if (!token) return <Login onLogin={setToken} />;

  async function saveConfig(event) {
    event.preventDefault();
    setMessage('Salvando alterações…');

    try {
      await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) });
      if (secretForm.aiApiKey.trim()) {
        await authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ aiApiKey: secretForm.aiApiKey }) });
      }
      if (secretForm.geminiApiKey.trim()) {
        await authApi('/admin/secrets', {
          method: 'PUT',
          body: JSON.stringify({
            geminiApiKey: secretForm.geminiApiKey
          })
        });
      }

      if (secretForm.openaiApiKey.trim()) {
        await authApi('/admin/secrets', {
          method: 'PUT',
          body: JSON.stringify({
            openaiApiKey: secretForm.openaiApiKey
          })
        });
      }

      setSecretForm((current) => ({
        ...current,
        aiApiKey: '',
        geminiApiKey: '',
        openaiApiKey: ''
      }));
      await load();
      setMessage('Configurações salvas.');
    } catch (error) {
      setMessage(`Não foi possível salvar: ${error.message}`);
    }
  }

  async function downloadBackup() {
    try {
      const backup = await authApi('/admin/backup');
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `promoshop-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('Backup seguro baixado. Ele não contém senhas nem dados pessoais.');
    } catch (error) {
      setMessage(`Não foi possível criar o backup: ${error.message}`);
    }
  }

  async function restoreBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      await authApi('/admin/backup/restore', { method: 'POST', body: JSON.stringify(backup) });
      await load();
      setMessage('Configurações e cupons restaurados com sucesso.');
    } catch (error) {
      setMessage(`Não foi possível restaurar: ${error.message || 'arquivo inválido'}`);
    }
  }

  async function checkOfferLinks() {
    setMessage('Verificando um lote de links seguros…');
    try {
      const result = await authApi('/admin/maintenance/check-links', { method: 'POST', body: '{}' });
      await load();
      setMessage(`Links verificados: ${result.ok} funcionando, ${result.broken} indisponível(is) e ${result.unknown} inconclusivo(s).`);
    } catch (error) {
      setMessage(`Não foi possível verificar os links: ${error.message}`);
    }
  }
  async function saveSources(event) {
    event.preventDefault();
    await Promise.all([
      authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
      authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ mercadoLivreClientId: secretForm.mercadoLivreClientId, mercadoLivreClientSecret: secretForm.mercadoLivreClientSecret, mercadoLivreAccessToken: secretForm.mercadoLivreAccessToken, shopeeAppId: secretForm.shopeeAppId, shopeeAppSecret: secretForm.shopeeAppSecret, aliexpressAppKey: secretForm.aliexpressAppKey, aliexpressAppSecret: secretForm.aliexpressAppSecret, aliexpressAppSignature: secretForm.aliexpressAppSignature, magaluAffiliateId: secretForm.magaluAffiliateId, magaluApiKey: secretForm.magaluApiKey, netshoesAffiliateId: secretForm.netshoesAffiliateId, netshoesApiKey: secretForm.netshoesApiKey }) })
    ]);
    setSecretForm((current) => ({ ...current, mercadoLivreClientSecret: '', mercadoLivreAccessToken: '', shopeeAppSecret: '', aliexpressAppSecret: '', aliexpressAppSignature: '', magaluApiKey: '', netshoesApiKey: '' }));
    await load();
    setMessage('Fontes e credenciais salvas com segurança.');
  }
  async function connectMercadoLivre() {
    setMessage('Preparando a conexão segura com o Mercado Livre…');
    try {
      const redirectUri = data.config.mercadoLivreRedirectUri || `${window.location.origin}/api/mercadolivre/callback`;
      await Promise.all([
        authApi('/admin/config', { method: 'PUT', body: JSON.stringify({ ...data.config, mercadoLivreRedirectUri: redirectUri }) }),
        authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ mercadoLivreClientId: secretForm.mercadoLivreClientId, mercadoLivreClientSecret: secretForm.mercadoLivreClientSecret }) })
      ]);
      const result = await authApi('/admin/sources/mercadolivre/connect', { method: 'POST', body: JSON.stringify({ redirectUri }) });
      window.location.assign(result.authorizationUrl);
    } catch (error) { setMessage(error.message); }
  }
  async function saveMercadoLivreAffiliate() {
    setMessage('Salvando automação de afiliados do Mercado Livre…');

    try {
      const payload = {};

      if (secretForm.mercadoLivreAffiliateCookie.trim()) {
        payload.mercadoLivreAffiliateCookie =
          secretForm.mercadoLivreAffiliateCookie.trim();
      }

      if (secretForm.mercadoLivreAffiliateCsrfToken.trim()) {
        payload.mercadoLivreAffiliateCsrfToken =
          secretForm.mercadoLivreAffiliateCsrfToken.trim();
      }

      if (secretForm.mercadoLivreAffiliateTag.trim()) {
        payload.mercadoLivreAffiliateTag =
          secretForm.mercadoLivreAffiliateTag.trim();
      }

      await authApi('/admin/secrets', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      setSecretForm((current) => ({
        ...current,
        mercadoLivreAffiliateCookie: '',
        mercadoLivreAffiliateCsrfToken: ''
      }));

      await load();

      setMessage(
        'Credenciais de afiliado do Mercado Livre salvas com segurança.'
      );
    } catch (error) {
      setMessage(error.message);
    }
  }
  async function testMercadoLivre() {
    setMessage('Testando a conexão do Mercado Livre…');
    try {
      const result = await authApi('/admin/sources/mercadolivre/test', { method: 'POST', body: '{}' });
      await load();
      setMessage(`Mercado Livre conectado${result.nickname ? ` como ${result.nickname}` : ''}: ${result.count} ofertas encontradas${result.sample ? `, incluindo “${result.sample}”` : ''}.`);
    } catch (error) { setMessage(error.message); }
  }
  async function testShopee() {
    setMessage('Testando a Open API da Shopee…');
    try {
      await Promise.all([
        authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
        authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ shopeeAppId: secretForm.shopeeAppId, shopeeAppSecret: secretForm.shopeeAppSecret }) })
      ]);
      const result = await authApi('/admin/sources/shopee/test', { method: 'POST', body: '{}' });
      setSecretForm((current) => ({ ...current, shopeeAppSecret: '' }));
      await load();
      setMessage(`Shopee conectada: ${result.count} ofertas encontradas${result.sample ? `, incluindo “${result.sample}”` : ''}.`);
    } catch (error) { setMessage(error.message); }
  }
  async function testAliexpress() {
    setMessage('Testando a Open API do AliExpress…');
    try {
      await Promise.all([
        authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
        authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ aliexpressAppKey: secretForm.aliexpressAppKey, aliexpressAppSecret: secretForm.aliexpressAppSecret, aliexpressAppSignature: secretForm.aliexpressAppSignature }) })
      ]);
      const result = await authApi('/admin/sources/aliexpress/test', { method: 'POST', body: '{}' });
      setSecretForm((current) => ({ ...current, aliexpressAppSecret: '', aliexpressAppSignature: '' }));
      await load();
      setMessage(`AliExpress conectado: ${result.count} ofertas encontradas${result.sample ? `, incluindo “${result.sample}”` : ''}.`);
    } catch (error) { setMessage(error.message); }
  }
  async function testAi() {
    setMessage('A IA está criando um texto de teste…');
    setAiPreview('');
    try {
      await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) });
      if (secretForm.aiApiKey.trim()) {
        await authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ aiApiKey: secretForm.aiApiKey }) });
      }
      if (secretForm.geminiApiKey.trim()) {
        await authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ geminiApiKey: secretForm.geminiApiKey }) });
      }
      if (secretForm.openaiApiKey.trim()) {
        await authApi('/admin/secrets', {
          method: 'PUT',
          body: JSON.stringify({
            openaiApiKey: secretForm.openaiApiKey
          })
        });
      }
      const result = await authApi('/admin/ai/test', { method: 'POST', body: '{}' });
      setSecretForm((current) => ({ ...current, aiApiKey: '', geminiApiKey: '' }));
      await load();
      setAiPreview(result.message);
      setMessage(`IA funcionando. Texto criado para “${result.offerTitle}”.`);
    } catch (error) { setMessage(error.message); }
  }
  async function saveSecurity(event) {
    event.preventDefault();
    await authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ adminUser: secretForm.adminUser || data.secrets?.adminUser || 'admin', adminPassword: secretForm.adminPassword }) });
    setSecretForm((current) => ({ ...current, adminPassword: '' }));
    setMessage('Acesso administrativo atualizado. Use os novos dados no próximo login.');
  }
  async function addOffer(event) {
    event.preventDefault();
    try {
      const isEditing = Boolean(editingOfferId);
      await authApi(isEditing ? `/admin/offers/${editingOfferId}` : '/admin/offers', {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(newOffer)
      });
      setNewOffer(defaultNewOffer);
      setEditingOfferId('');
      await load();
      setMessage(isEditing ? 'Oferta atualizada e revisada.' : 'Oferta adicionada.');
    } catch (error) {
      setMessage(`Não foi possível ${editingOfferId ? 'atualizar' : 'adicionar'} a oferta: ${error.message}`);
    }
  }

  function editOffer(offer) {
    setEditingOfferId(offer.id);
    setNewOffer(offerFormFromOffer(offer));
    setTab('offers');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMessage('Oferta carregada para edição. Corrija os dados e clique em Salvar alterações.');
  }

  function cancelOfferEdit() {
    setEditingOfferId('');
    setNewOffer(defaultNewOffer);
    setMessage('Edição da oferta cancelada.');
  }
  async function addCoupon(event) {
    event.preventDefault();
    if (!couponForm.targetAudienceCodes.length) {
      setMessage('Selecione pelo menos um grupo para o cupom.');
      return;
    }
    try {
      const payload = {
        ...couponForm,
        expiresAt: couponForm.expiresAt ? new Date(couponForm.expiresAt).toISOString() : ''
      };
      const isEditing = Boolean(editingCouponId);
      await authApi(isEditing ? `/admin/coupons/${editingCouponId}` : '/admin/coupons', { method: isEditing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setCouponForm(defaultCoupon);
      setEditingCouponId('');
      await load();
      setMessage(isEditing ? 'Cupom atualizado e visível no site.' : 'Cupom cadastrado e visível no site.');
    } catch (error) {
      setMessage(`Não foi possível ${editingCouponId ? 'atualizar' : 'cadastrar'} o cupom: ${error.message}`);
    }
  }
  function editCoupon(coupon) {
    setEditingCouponId(coupon.id);
    setCouponForm(couponFormFromCoupon(coupon));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMessage('Cupom carregado para edição.');
  }
  function cancelCouponEdit() {
    setEditingCouponId('');
    setCouponForm(defaultCoupon);
    setMessage('Edição cancelada.');
  }
  async function copyShortCouponUrl(coupon) {
    const shortUrl = String(coupon?.shortUrl || '').trim();
    if (!shortUrl) {
      setMessage('Este cupom ainda não possui um link curto.');
      return;
    }
    try {
      await navigator.clipboard.writeText(shortUrl);
      setMessage('Link curto copiado.');
    } catch {
      setMessage('Não foi possível copiar o link curto neste navegador.');
    }
  }
  async function removeCoupon(id) {
    if (!window.confirm('Excluir este cupom?')) return;
    try {
      await authApi(`/admin/coupons/${id}`, { method: 'DELETE' });
      await load();
      setMessage('Cupom excluído.');
    } catch (error) {
      setMessage(error.message);
    }
  }
  async function queueCoupon(id, force = true) {
    try {
      await authApi(`/admin/coupons/${id}/queue`, { method: 'POST', body: JSON.stringify({ force }) });
      await load();
      setMessage(force ? 'Cupom priorizado para envio aos grupos selecionados.' : 'Cupom colocado na fila.');
    } catch (error) {
      setMessage(error.message);
    }
  }
  function removeOffer(id) {
    const offer = data.offers.find((item) => item.id === id);
    setDialog({ type: 'delete-offer', offer });
  }
  async function confirmRemoveOffer() {
    if (!dialog?.offer?.id) return;
    try {
      await authApi(`/admin/offers/${dialog.offer.id}`, { method: 'DELETE' });
      setDialog(null);
      await load();
      setMessage('Oferta excluída.');
    } catch (error) { setMessage(error.message); }
  }
  async function queueOffer(id, force = false) { await authApi(`/admin/offers/${id}/queue`, { method: 'POST', body: JSON.stringify({ force }) }); await load(); setMessage(force ? 'Publicação priorizada. O envio será feito em alguns segundos.' : 'Oferta colocada na fila do WhatsApp.'); }
  async function forceQueueItem(id) { await authApi(`/admin/queue/${id}/force`, { method: 'POST', body: '{}' }); await load(); setMessage('Publicação priorizada. O envio será feito em alguns segundos.'); }
  async function retryQueueItem(id) { await authApi(`/admin/queue/${id}/retry`, { method: 'POST', body: '{}' }); await load(); setMessage('Nova tentativa priorizada. O envio será feito em alguns segundos.'); }
  async function removeQueueItem(id) { await authApi(`/admin/queue/${id}`, { method: 'DELETE' }); await load(); setMessage('Item removido da fila.'); }
  async function clearFailedQueue() {
    const failedCount = data.queue.filter((item) => item.status === 'failed').length;
    if (!failedCount || !window.confirm(`Excluir ${failedCount} publicação(ões) com falha da fila?`)) return;

    try {
      const result = await authApi('/admin/queue/failed', { method: 'DELETE' });
      await load();
      setMessage(`${result.removed || failedCount} publicação(ões) com falha removida(s).`);
    } catch (error) {
      setMessage(`Não foi possível excluir as falhas: ${error.message}`);
    }
  }
  async function markInboxMessage(id, status = 'read') {
    try {
      await authApi(`/admin/inbox/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      await load({ preserveConfig: true });
    } catch (error) {
      setMessage(`Não foi possível atualizar a mensagem: ${error.message}`);
    }
  }
  async function replyInboxMessage(id, replyText) {
    const result = await authApi(`/admin/inbox/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message: replyText })
    });
    await load({ preserveConfig: true });
    setMessage('Resposta enviada pelo Brevo.');
    return result;
  }
  async function setupInboxInbound(domain) {
    setMessage('Configurando recebimento de respostas pela Brevo…');
    try {
      const result = await authApi('/admin/inbox/setup', {
        method: 'POST',
        body: JSON.stringify({ domain })
      });
      await load();
      setMessage('Recebimento ativado. Agora adicione os registros MX exibidos na configuração do domínio.');
      return result;
    } catch (error) {
      setMessage(error.message);
      throw error;
    }
  }
  function activateOffer(offer) {
    setDialog({
      type: 'affiliate-link',
      offer,
      value: offer.productUrl || offer.affiliateUrl || ''
    });
  }
  async function confirmAffiliateLink(event) {
    event.preventDefault();
    const affiliateUrl = String(dialog?.value || '').trim();
    if (!dialog?.offer?.id || !affiliateUrl) return;
    try {
      await authApi(`/admin/offers/${dialog.offer.id}`, { method: 'PUT', body: JSON.stringify({ affiliateUrl, status: 'active' }) });
      setDialog(null);
      await load();
      setMessage('Link confirmado e oferta publicada.');
    } catch (error) { setMessage(error.message); }
  }
  async function collect() { setMessage('Buscando novas ofertas…'); try { const result = await authApi('/admin/collect', { method: 'POST' }); await load(); setMessage(`${result.imported} novas ofertas encontradas.`); } catch (err) { setMessage(err.message); } }
  async function startWhatsapp(mode = 'qr') {
    setMessage('Iniciando o publicador do WhatsApp…');

    try {
      // A conexão não depende do salvamento do formulário. Isso permite
      // reconectar mesmo quando existe uma configuração antiga pendente.
      const result = await authApi('/admin/whatsapp/start', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          phoneNumber: mode === 'phone' ? phoneNumber : undefined
        })
      });
      setMessage(result.message);
      window.setTimeout(load, 1500);
    } catch (error) {
      setMessage(`Não foi possível iniciar o WhatsApp: ${error.message}`);
    }
  }

  async function reconnectWhatsapp() {
    setMessage('Restabelecendo a conexão do WhatsApp…');

    try {
      const result = await authApi('/admin/whatsapp/reconnect', {
        method: 'POST',
        body: '{}'
      });

      await load();
      setMessage(result.message || 'Reconexão solicitada. Aguarde alguns segundos.');
      window.setTimeout(() => load({ preserveConfig: true }), 1800);
    } catch (error) {
      setMessage(`Não foi possível reconectar o WhatsApp: ${error.message}`);
    }
  }

  async function stopWhatsapp() {
    try {
      await authApi('/admin/whatsapp/stop', {
        method: 'POST',
        body: '{}'
      });
      await load();
      setMessage('Publicador parado.');
    } catch (error) {
      setMessage(`Não foi possível desconectar: ${error.message}`);
    }
  }
  async function checkWhatsappConnection() {
    setMessage('Verificando a conexão com o WhatsApp…');

    try {
      const result = await authApi(
        '/admin/whatsapp/check',
        {
          method: 'POST',
          body: '{}'
        }
      );

      await load();

      setMessage(
        result.connected
          ? 'WhatsApp conectado e publicador funcionando normalmente.'
          : result.message || 'WhatsApp desconectado.'
      );
    } catch (error) {
      setMessage(error.message);
    }
  }
  async function searchProducts(event) {
    event.preventDefault();

    const query = String(productSearch.query || '').trim();

    if (!query) {
      setMessage('Digite o nome do produto que deseja buscar.');
      return;
    }

    if (!productSearch.stores.length) {
      setMessage('Selecione pelo menos uma loja para pesquisar.');
      return;
    }

    setProductSearchLoading(true);
    setProductSearchResults([]);
    setProductSearchErrors([]);
    setProductSearchStoreCounts({});
    setMagaluStoreUrl('');
    setMessage(`Buscando "${query}" nas lojas selecionadas…`);

    try {
      const result = await authApi('/admin/search-products', {
        method: 'POST',
        body: JSON.stringify({
          query,
          stores: productSearch.stores,
          strict: productSearch.strict !== false,
          limit:
            productSearch.limit === 'all'
              ? 'all'
              : Number(productSearch.limit || 10)
        })
      });

      setProductSearchResults(
        Array.isArray(result.results)
          ? result.results
          : []
      );

      setProductSearchErrors(
        Array.isArray(result.errors)
          ? result.errors
          : []
      );
      setProductSearchStoreCounts(result.visibleCounts || {});
      setMagaluStoreUrl(result.magaluStoreUrl || '');

      if (result.count > 0) {
        setMessage(
          `${result.count} produto${result.count === 1 ? '' : 's'} relevante${result.count === 1 ? '' : 's'} encontrado${result.count === 1 ? '' : 's'} para "${query}"${result.discarded ? `. ${result.discarded} resultado(s) sem relação foram descartados.` : '.'}`
        );
      } else {
        setMessage(
          `Nenhum produto realmente compatível encontrado para "${query}"${result.discarded ? `. A busca descartou ${result.discarded} resultado(s) apenas parecido(s) ou de acessórios.` : '.'}`
        );
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setProductSearchLoading(false);
    }
  }
  function useSearchResult(offer) {
    setEditingOfferId('');
    setNewOffer({
      title: offer.title || '',
      store: offer.store || 'Mercado Livre',
      category: offer.category || '',
      price: Number(offer.price || 0) || '',
      originalPrice: Number(offer.originalPrice || 0) || '',
      image: offer.image || '',
      affiliateUrl: offer.affiliateUrl || offer.productUrl || '',
      freeShipping: Boolean(offer.freeShipping),
      featured: Boolean(offer.featured),
      status: offer.affiliateUrl
        ? 'active'
        : 'pending-link'
    });

    setMessage(
      `"${offer.title}" foi carregado no formulário. Confira os dados antes de adicionar.`
    );
  }
  function logout() { localStorage.removeItem('promoshop_token'); setToken(null); }

  async function bulkReview(action) {
    if (!reviewSelected.length) return setMessage('Selecione pelo menos uma oferta.');
    try {
      const result = await authApi('/admin/offers/bulk', { method: 'POST', body: JSON.stringify({ ids: reviewSelected, action }) });
      setMessage(`${result.updated || 0} oferta(s) atualizada(s).`);
      setReviewSelected([]);
      await load();
    } catch (error) { setMessage(error.message); }
  }

  async function loadSearchConsole() {
    try { setSearchConsoleData(await authApi('/admin/search-console/summary')); }
    catch (error) { setMessage(error.message); }
  }

  async function connectSearchConsole() {
    try {
      await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) });
      await authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ googleSearchConsoleClientId: secretForm.googleSearchConsoleClientId, googleSearchConsoleClientSecret: secretForm.googleSearchConsoleClientSecret }) });
      const result = await authApi('/admin/search-console/connect', { method: 'POST', body: '{}' });
      window.location.href = result.authorizationUrl;
    } catch (error) { setMessage(error.message); }
  }

  const tabLabels = { overview: 'Visão geral', offers: 'Ofertas', review: 'Revisar ofertas', coupons: 'Cupons', inbox: 'Caixa de entrada', queue: 'Fila de publicação', sources: 'Fontes de ofertas', whatsapp: 'WhatsApp', analytics: 'Acessos', health: 'Saúde e backup', settings: 'Site e políticas', security: 'Segurança', logs: 'Atividades' };
  const tabDescriptions = { overview: 'Acompanhe o que está ativo e o que será publicado.', offers: 'Consulte e publique as ofertas disponíveis.', review: 'Encontre ofertas antigas, incompletas ou com baixa qualidade.', coupons: 'Cadastre, divulgue e envie cupons para grupos específicos.', inbox: 'Leia as mensagens do formulário e responda pelo painel.', queue: 'Controle a ordem e o estado das publicações.', sources: 'Configure cada plataforma e as regras de coleta.', whatsapp: 'Gerencie conexão, grupos e horários de publicação.', analytics: 'Veja acessos e interações anônimas autorizadas.', health: 'Confira os componentes do sistema e proteja suas configurações.', settings: 'Edite identidade, SEO, qualidade, privacidade e informações legais.', security: 'Altere o acesso ao painel administrativo.', logs: 'Consulte as ações e os erros recentes do sistema.' };
  const navIcons = { overview: '⌂', offers: '◇', review: '!', coupons: '♢', inbox: '✉', queue: '↗', sources: '⌁', whatsapp: '◉', analytics: '▥', health: '✓', settings: '✦', security: '⌾', logs: '≡' };
  const navGroups = [
    { label: 'Operação', items: ['overview', 'offers', 'review', 'coupons', 'inbox', 'queue'] },
    { label: 'Automação', items: ['sources', 'whatsapp'] },
    { label: 'Sistema', items: ['analytics', 'health', 'settings', 'security', 'logs'] }
  ];
  const whatsapp = data.meta?.whatsapp || {};
  const unreadInboxCount = (data.inbox || []).filter((item) => item.status === 'unread').length;
  const statusLabels = { offline: 'Desconectado', starting: 'Iniciando', qr: 'Aguardando leitura do QR Code', pairing: 'Código gerado', authenticated: 'Autenticado', connected: 'Conectado', error: 'Erro' };
  const formattedPairingCode = String(whatsapp.pairingCode || '').replace(/\s/g, '').match(/.{1,4}/g)?.join(' ') || '';
  const configuredAudiences = Array.isArray(data.config.whatsappAudiences) ? data.config.whatsappAudiences : [];
  const adminStores = ['Todas', ...new Set(data.offers.map((offer) => offer.store))];
  const adminFilteredOffers = data.offers.filter((offer) => `${offer.title} ${offer.store} ${offer.category}`.toLowerCase().includes(adminOfferQuery.toLowerCase()) && (adminOfferStore === 'Todas' || offer.store === adminOfferStore));
  const reviewOffers = data.offers.filter((offer) => reviewFilter === 'all' || (reviewFilter === 'stale' ? offer.isStale : reviewFilter === 'low' ? Number(offer.qualityScore || 0) < Number(data.config.qualityMinimumScore || 55) : reviewFilter === 'paused' ? offer.status !== 'active' : (offer.isStale || Number(offer.qualityScore || 0) < Number(data.config.qualityMinimumScore || 55) || (offer.qualityIssues || []).length)));
  const setConfigField = (key, value) => setData((current) => ({
    ...current,
    config: { ...current.config, [key]: value }
  }));

  return <div className="admin-shell"><aside><div className="sidebar-brand"><Logo name={data.config.brandName || 'PromoShop'} /><small>Painel administrativo</small></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map((id) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><i>{navIcons[id]}</i><span className="nav-label">{tabLabels[id]}</span>{id === 'inbox' && unreadInboxCount > 0 && <b className="nav-badge">{unreadInboxCount > 99 ? '99+' : unreadInboxCount}</b>}</button>)}</div>)}</nav><div className="sidebar-footer"><a href="/">Ver site <span>↗</span></a><button className="logout" onClick={logout}>Sair</button></div></aside><main className="admin-main"><header><div><span className="eyebrow dark">CENTRAL DE CONTROLE</span><h1>{tabLabels[tab]}</h1><p>{tabDescriptions[tab]}</p></div><div className="header-actions"><span className={`header-status ${whatsapp.status === 'connected' ? 'online' : ''}`}><i></i>WhatsApp {whatsapp.status === 'connected' ? 'ativo' : 'inativo'}</span>{['overview', 'offers', 'sources'].includes(tab) && <button className="button primary" onClick={collect}>Atualizar ofertas</button>}</div></header>{message && <div className="toast" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Fechar aviso">×</button></div>}
    {tab === 'overview' && <div className="overview-layout"><section className="welcome-panel"><div><span className="eyebrow">RESUMO DA AUTOMAÇÃO</span><h2>{whatsapp.status === 'connected' ? 'Tudo pronto para publicar' : 'WhatsApp precisa de atenção'}</h2><p>{whatsapp.status === 'connected' ? `O publicador está conectado a ${(data.config.whatsappGroups || []).length} grupo(s) e segue a agenda configurada.` : 'Conecte o WhatsApp para que as ofertas da fila sejam enviadas automaticamente.'}</p></div><button className="button light" onClick={() => setTab('whatsapp')}>{whatsapp.status === 'connected' ? 'Ver configuração' : 'Conectar WhatsApp'}</button></section><div className="stats"><div><span><i>◇</i>Ofertas ativas</span><strong>{data.offers.filter((o) => o.status === 'active').length}</strong><small>Disponíveis no site</small></div><div><span><i>↗</i>Na fila</span><strong>{data.queue.filter((q) => q.status === 'pending').length}</strong><small>Aguardando publicação</small></div><div><span><i>✓</i>Enviadas</span><strong>{data.queue.filter((q) => q.status === 'sent').length}</strong><small>Publicações concluídas</small></div><div><span><i>⌁</i>Fontes ativas</span><strong>{[data.config.enableMercadoLivre, data.config.enableShopee, data.config.enableAliexpress, data.config.enableMagalu].filter(Boolean).length}</strong><small>Coletas automáticas</small></div></div><section className="panel table-panel"><div className="panel-heading"><div><h2>Próximas publicações</h2><p>Itens que serão enviados primeiro.</p></div><button className="text-button" onClick={() => setTab('queue')}>Ver fila completa →</button></div><QueueTable queue={data.queue.filter((item) => item.status === 'pending').slice(0, 5)} /></section></div>}
    {tab === 'offers' && (
      <div className="offers-admin-layout">

        <section className="panel product-search-panel">
          <div className="panel-heading">
            <div>
              <span className="section-step">BUSCA MANUAL</span>
              <h2>Buscar produto nas lojas</h2>
              <p>
                A busca confere o tipo do produto, modelo e características importantes antes de mostrar o resultado. No Magalu, a vitrine pode exigir captcha; nesse caso o painel abre a busca da sua loja.
              </p>
            </div>
          </div>

          <form
            className="product-search-form"
            onSubmit={searchProducts}
          >
            <label className="product-search-query">
              Produto
              <input
                value={productSearch.query}
                onChange={(event) =>
                  setProductSearch({
                    ...productSearch,
                    query: event.target.value
                  })
                }
                placeholder="Ex.: iPhone 15 128GB, Air Fryer Mondial, JBL Boombox 3"
              />
            </label>

            <label>
              Resultados por loja

              <select
                value={productSearch.limit}
                onChange={(event) =>
                  setProductSearch({
                    ...productSearch,
                    limit:
                      event.target.value === 'all'
                        ? 'all'
                        : Number(event.target.value)
                  })
                }
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={30}>30</option>
                <option value={50}>50</option>
              </select>
            </label>

            <label className="product-search-strict">
              <input type="checkbox" checked={productSearch.strict !== false} onChange={(event) => setProductSearch({ ...productSearch, strict: event.target.checked })} />
              <span><strong>Busca exata</strong><small>Descarta acessórios e produtos apenas parecidos. Desmarque somente se quiser uma busca mais ampla.</small></span>
            </label>

            <div className="product-search-stores">
              <span>Onde pesquisar</span>

              <label>
                <input
                  type="checkbox"
                  checked={productSearch.stores.includes('mercadolivre')}
                  onChange={(event) => {
                    const stores = event.target.checked
                      ? [
                        ...new Set([
                          ...productSearch.stores,
                          'mercadolivre'
                        ])
                      ]
                      : productSearch.stores.filter(
                        (store) => store !== 'mercadolivre'
                      );

                    setProductSearch({
                      ...productSearch,
                      stores
                    });
                  }}
                />

                Mercado Livre
              </label>

              <label>
                <input
                  type="checkbox"
                  checked={productSearch.stores.includes('shopee')}
                  onChange={(event) => {
                    const stores = event.target.checked
                      ? [
                        ...new Set([
                          ...productSearch.stores,
                          'shopee'
                        ])
                      ]
                      : productSearch.stores.filter(
                        (store) => store !== 'shopee'
                      );

                    setProductSearch({
                      ...productSearch,
                      stores
                    });
                  }}
                />

                Shopee
              </label>

              <label>
                <input
                  type="checkbox"
                  checked={productSearch.stores.includes('magalu')}
                  onChange={(event) => {
                    const stores = event.target.checked
                      ? [...new Set([...productSearch.stores, 'magalu'])]
                      : productSearch.stores.filter((store) => store !== 'magalu');
                    setProductSearch({ ...productSearch, stores });
                  }}
                />
                Magalu
              </label>
            </div>

            <button
              className="button primary"
              type="submit"
              disabled={productSearchLoading}
            >
              {productSearchLoading
                ? 'Buscando…'
                : 'Buscar produtos'}
            </button>
          </form>

          {productSearchErrors.length > 0 && (
            <div className="product-search-errors">
              {productSearchErrors.map((error) => (
                <p key={error}>{error}</p>
              ))}
              {magaluStoreUrl && (
                <a className="button subtle" href={magaluStoreUrl} target="_blank" rel="noreferrer">
                  Abrir busca da minha loja Magalu ↗
                </a>
              )}
            </div>
          )}

          {productSearchResults.length > 0 && (
            <div className="product-search-results">

              <div className="product-search-results-head">
                <strong>
                  {productSearchResults.length} resultado
                  {productSearchResults.length === 1 ? '' : 's'}
                </strong>

                <span className="product-search-store-counts">
                  {Object.entries(productSearchStoreCounts).map(([store, count]) => `${store}: ${count}`).join(' · ')}
                </span>

                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setProductSearchResults([]);
                    setProductSearchErrors([]);
                    setProductSearchStoreCounts({});
                  }}
                >
                  Limpar resultados
                </button>
              </div>

              <div className="product-search-grid">
                {productSearchResults.map((offer, index) => (
                  <article
                    className="product-search-card"
                    key={`${offer.store}-${offer.id}-${index}`}
                  >
                    <div className="product-search-image">
                      {offer.image ? (
                        <img
                          src={offer.image}
                          alt={offer.title}
                        />
                      ) : (
                        <span>Sem imagem</span>
                      )}
                    </div>

                    <div className="product-search-card-content">
                      <span className="product-search-store">
                        {offer.store}
                      </span>

                      {offer.relevance && <span className="product-search-relevance">{offer.relevance.score}% compatível</span>}

                      <h3>{offer.title}</h3>

                      <div className="product-search-price">
                        {Number(offer.originalPrice) >
                          Number(offer.price) && (
                            <s>
                              {money.format(
                                Number(offer.originalPrice)
                              )}
                            </s>
                          )}

                        <strong>
                          {money.format(
                            Number(offer.price || 0)
                          )}
                        </strong>

                        {discount(offer) > 0 && (
                          <span>
                            {discount(offer)}% OFF
                          </span>
                        )}
                      </div>

                      {offer.freeShipping && (
                        <small className="shipping">
                          Frete grátis
                        </small>
                      )}

                      <div className="product-search-actions">
                        {offer.productUrl && (
                          <a
                            className="button subtle"
                            href={offer.productUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Ver produto
                          </a>
                        )}

                        <button
                          className="button primary"
                          type="button"
                          onClick={() => useSearchResult(offer)}
                        >
                          Usar esta oferta
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>


        <div className="admin-columns">

          <form
            className="panel form-grid create-offer-panel"
            onSubmit={addOffer}
          >
            <div className="panel-heading">
              <div>
                <span className="section-step">
                  {editingOfferId ? 'EDIÇÃO DE OFERTA' : 'CADASTRO MANUAL'}
                </span>

                <h2>{editingOfferId ? 'Editar oferta' : 'Adicionar oferta'}</h2>

                <p>
                  {editingOfferId
                    ? 'Confira os dados, corrija o que for necessário e salve a revisão.'
                    : 'Use uma oferta encontrada acima ou preencha manualmente.'}
                </p>
              </div>
            </div>

            {[
              ['title', 'Produto'],
              ['category', 'Categoria'],
              ['price', 'Preço atual'],
              ['originalPrice', 'Preço anterior'],
              ['image', 'URL da imagem'],
              ['affiliateUrl', 'Link de afiliado']
            ].map(([key, label]) => (
              <label key={key}>
                {label}

                <input
                  required={!['originalPrice'].includes(key)}
                  type={
                    key.includes('Price') || key === 'price'
                      ? 'number'
                      : 'text'
                  }
                  step="0.01"
                  value={newOffer[key]}
                  onChange={(event) =>
                    setNewOffer({
                      ...newOffer,
                      [key]: event.target.value
                    })
                  }
                />
              </label>
            ))}

            <label>
              Loja

              <select
                value={newOffer.store}
                onChange={(event) =>
                  setNewOffer({
                    ...newOffer,
                    store: event.target.value
                  })
                }
              >
                <option>Mercado Livre</option>
                <option>Shopee</option>
                <option>AliExpress</option>
                <option>Magalu</option>
                <option>Outra</option>
              </select>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={newOffer.freeShipping}
                onChange={(event) =>
                  setNewOffer({
                    ...newOffer,
                    freeShipping: event.target.checked
                  })
                }
              />

              Frete grátis
            </label>

            <div className="offer-form-actions">
              {editingOfferId && <button className="button subtle" type="button" onClick={cancelOfferEdit}>Cancelar edição</button>}
              <button className="button primary" type="submit">{editingOfferId ? 'Salvar alterações' : 'Adicionar oferta'}</button>
            </div>
          </form>


          <section className="panel table-panel offers-manager">
            <div className="panel-heading">
              <div>
                <h2>Ofertas cadastradas</h2>

                <p>
                  {adminFilteredOffers.length} de {data.offers.length}{' '}
                  ofertas
                </p>
              </div>
            </div>

            <div className="admin-toolbar">
              <label className="admin-search">
                <span>⌕</span>

                <input
                  value={adminOfferQuery}
                  onChange={(event) =>
                    setAdminOfferQuery(event.target.value)
                  }
                  placeholder="Buscar oferta"
                />
              </label>

              <select
                value={adminOfferStore}
                onChange={(event) =>
                  setAdminOfferStore(event.target.value)
                }
                aria-label="Filtrar ofertas por loja"
              >
                {adminStores.map((item) => (
                  <option key={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>

            <div className="offer-admin-list">
              {adminFilteredOffers.map((offer) => (
                <div key={offer.id}>
                  <img
                    src={offer.image}
                    alt=""
                  />

                  <span>
                    <strong>
                      {offer.title}
                    </strong>

                    <small>
                      {offer.store}
                      {' · '}
                      {money.format(Number(offer.price))}
                      {' · '}
                      {offer.status === 'active'
                        ? 'Publicada'
                        : 'Aguardando link'}
                    </small>
                    <small className={`offer-quality ${offer.isStale || Number(offer.qualityScore || 0) < Number(data.config.qualityMinimumScore || 55) ? 'warning' : 'ok'}`}>
                      Qualidade {Number(offer.qualityScore || 0)}/100
                      {offer.isStale ? ' · oferta antiga' : ''}
                      {Array.isArray(offer.qualityIssues) && offer.qualityIssues.length ? ` · ${offer.qualityIssues.join(', ')}` : ''}
                    </small>
                  </span>

                  <div className="offer-row-actions">
                    <button onClick={() => editOffer(offer)}>Editar</button>
                    {offer.status === 'active' ? (
                      <>
                        <button
                          onClick={() =>
                            queueOffer(offer.id)
                          }
                        >
                          Agendar
                        </button>

                        <button
                          className="force"
                          onClick={() =>
                            queueOffer(offer.id, true)
                          }
                        >
                          Publicar agora
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() =>
                          activateOffer(offer)
                        }
                      >
                        Vincular
                      </button>
                    )}

                    <button
                      className="danger"
                      onClick={() =>
                        removeOffer(offer.id)
                      }
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

        </div>
      </div>
    )}
    {tab === 'review' && <div className="review-layout">
      <section className="panel review-summary"><div><span className="section-step">CONTROLE DE QUALIDADE</span><h2>{reviewOffers.length} oferta(s) nesta revisão</h2><p>Use Editar para corrigir preço, título, imagem ou link. Pause o que não for confiável e só aprove depois de conferir a oferta na loja.</p></div><div className="review-filters"><button className={reviewFilter === 'attention' ? 'active' : ''} type="button" onClick={() => setReviewFilter('attention')}>Precisam de atenção</button><button className={reviewFilter === 'stale' ? 'active' : ''} type="button" onClick={() => setReviewFilter('stale')}>Antigas</button><button className={reviewFilter === 'low' ? 'active' : ''} type="button" onClick={() => setReviewFilter('low')}>Baixa qualidade</button><button className={reviewFilter === 'paused' ? 'active' : ''} type="button" onClick={() => setReviewFilter('paused')}>Pausadas</button><button className={reviewFilter === 'all' ? 'active' : ''} type="button" onClick={() => setReviewFilter('all')}>Todas</button></div></section>
      <section className="panel review-manager"><div className="panel-heading"><label className="review-select-all"><input type="checkbox" checked={reviewOffers.length > 0 && reviewOffers.every((offer) => reviewSelected.includes(offer.id))} onChange={(event) => setReviewSelected(event.target.checked ? reviewOffers.map((offer) => offer.id) : [])} /> Selecionar lista</label><div className="review-actions"><button className="button subtle" type="button" disabled={!reviewSelected.length} onClick={() => bulkReview('pause')}>Pausar selecionadas</button><button className="button primary" type="button" disabled={!reviewSelected.length} onClick={() => bulkReview('activate')}>Aprovar e ativar</button></div></div><div className="review-list">{reviewOffers.map((offer) => <article className="review-row" key={offer.id}><input type="checkbox" checked={reviewSelected.includes(offer.id)} onChange={(event) => setReviewSelected((current) => event.target.checked ? [...new Set([...current, offer.id])] : current.filter((id) => id !== offer.id))} /><img src={offer.image} alt="" /><div><strong>{offer.title}</strong><small>{offer.store} · {money.format(Number(offer.price || 0))} · {offer.status === 'active' ? 'Ativa' : 'Pausada'}</small><span className={`offer-quality ${offer.isStale || Number(offer.qualityScore || 0) < Number(data.config.qualityMinimumScore || 55) ? 'warning' : 'ok'}`}>Qualidade {Number(offer.qualityScore || 0)}/100{offer.isStale ? ' · antiga' : ''}{offer.qualityIssues?.length ? ` · ${offer.qualityIssues.join(', ')}` : ''}</span></div><div className="review-row-actions"><button className="button subtle" type="button" onClick={() => editOffer(offer)}>Editar</button><a className="button subtle" href={`/oferta/${offer.publicSlug || offer.id}`} target="_blank" rel="noreferrer">Visualizar ↗</a></div></article>)}{!reviewOffers.length && <div className="empty"><strong>Nenhuma oferta neste filtro</strong><p>O catálogo está limpo para este critério.</p></div>}</div></section>
    </div>}
    {tab === 'coupons' && <div className="coupons-admin-layout">
      <form className="panel form-grid coupon-form" onSubmit={addCoupon}>
        <div className="panel-heading"><div><span className="section-step">{editingCouponId ? 'EDIÇÃO DE CUPOM' : 'CADASTRO MANUAL'}</span><h2>{editingCouponId ? 'Editar cupom' : 'Novo cupom'}</h2><p>O cupom aparece no site e pode ser disparado apenas para os grupos marcados.</p></div></div>
        <label>Título<input required value={couponForm.title} onChange={(event) => setCouponForm({ ...couponForm, title: event.target.value })} placeholder="Ex.: 20% OFF em produtos selecionados" /></label>
        <label>Loja<select value={couponForm.store} onChange={(event) => setCouponForm({ ...couponForm, store: event.target.value })}><option>Magalu</option><option>Mercado Livre</option><option>Shopee</option><option>AliExpress</option><option>Outra</option></select></label>
        <label>Código do cupom<input value={couponForm.code} onChange={(event) => setCouponForm({ ...couponForm, code: event.target.value.toUpperCase() })} placeholder="PROMO20" /></label>
        <label>Descrição<textarea rows={3} value={couponForm.description} onChange={(event) => setCouponForm({ ...couponForm, description: event.target.value })} placeholder="Explique rapidamente onde o cupom pode ser usado." /></label>
        <div className="settings-grid two-columns"><label>Tipo de desconto<select value={couponForm.discountType} onChange={(event) => setCouponForm({ ...couponForm, discountType: event.target.value })}><option value="percent">Percentual</option><option value="fixed">Valor fixo</option><option value="free-shipping">Frete grátis</option></select></label><label>Valor do desconto<input type="number" min="0" step="0.01" value={couponForm.discountValue} onChange={(event) => setCouponForm({ ...couponForm, discountValue: event.target.value })} placeholder="20" /></label><label>Compra mínima<input type="number" min="0" step="0.01" value={couponForm.minPurchase} onChange={(event) => setCouponForm({ ...couponForm, minPurchase: event.target.value })} placeholder="Opcional" /></label><label>Validade<input type="datetime-local" value={couponForm.expiresAt} onChange={(event) => setCouponForm({ ...couponForm, expiresAt: event.target.value })} /></label></div>
        <label>Link para ativar o cupom<input required type="url" value={couponForm.link} onChange={(event) => setCouponForm({ ...couponForm, link: event.target.value })} placeholder="https://www.magazinevoce.com.br/..." /></label>
        <label>URL da imagem <small>(opcional)</small><input type="url" value={couponForm.image} onChange={(event) => setCouponForm({ ...couponForm, image: event.target.value })} placeholder="https://..." /></label>
        <div className="coupon-audience-picker"><strong>Enviar para estes grupos</strong><small>Selecione um ou mais destinos. O nome do grupo aparece em destaque; o código serve apenas para identificação interna.</small><div className="group-options">{configuredAudiences.filter((audience) => audience.enabled !== false).map((audience) => { const code = String(audience.code || '').toUpperCase(); const checked = couponForm.targetAudienceCodes.includes(code); return <label className="group-option" key={code}><input type="checkbox" checked={checked} onChange={(event) => setCouponForm({ ...couponForm, targetAudienceCodes: event.target.checked ? [...new Set([...couponForm.targetAudienceCodes, code])] : couponForm.targetAudienceCodes.filter((selected) => selected !== code) })} /><span className="coupon-group-label"><strong>{audience.name || 'Grupo sem nome'}</strong><small>{code}</small></span></label>; })}</div></div>
        <div className="settings-grid two-columns"><label className="toggle-card"><input type="checkbox" checked={couponForm.featured} onChange={(event) => setCouponForm({ ...couponForm, featured: event.target.checked })} /><span><strong>Destacar no site</strong><small>Mostra o cupom antes dos demais.</small></span></label><label className="toggle-card"><input type="checkbox" checked={couponForm.active} onChange={(event) => setCouponForm({ ...couponForm, active: event.target.checked })} /><span><strong>Ativo</strong><small>Cupons inativos não aparecem no site.</small></span></label></div>
        <div className="coupon-form-actions"><button className="button primary full" type="submit">{editingCouponId ? 'Salvar alterações' : 'Cadastrar cupom'}</button>{editingCouponId && <button className="coupon-cancel-button" type="button" onClick={cancelCouponEdit}>Cancelar edição</button>}</div>
      </form>
      <section className="panel table-panel coupon-manager"><div className="panel-heading"><div><span className="section-step">CUPONS CADASTRADOS</span><h2>Gerenciar cupons</h2><p>{(data.coupons || []).length} cadastrado(s). O disparo respeita os grupos escolhidos no cadastro.</p></div></div><div className="coupon-admin-list">{(data.coupons || []).map((coupon) => <article className="coupon-admin-row" key={coupon.id}><div><strong>{coupon.title}</strong><small>{coupon.store} · {coupon.code || 'sem código'} · {(coupon.targetAudienceCodes || []).join(', ') || 'sem grupo'}</small>{coupon.shortUrl && <small className="coupon-short-link">Link curto: {coupon.shortUrl}</small>}{coupon.expiresAt && <small>Validade: {new Date(coupon.expiresAt).toLocaleString('pt-BR')}</small>}</div><div className="coupon-row-actions"><button className="edit" type="button" onClick={() => editCoupon(coupon)}>Editar</button><button type="button" onClick={() => copyShortCouponUrl(coupon)}>Copiar link</button><button className="force" type="button" onClick={() => queueCoupon(coupon.id, true)}>Disparar agora</button><button type="button" onClick={() => queueCoupon(coupon.id, false)}>Agendar</button><button className="danger" type="button" onClick={() => removeCoupon(coupon.id)}>Excluir</button></div></article>)}{!(data.coupons || []).length && <div className="empty"><strong>Nenhum cupom cadastrado</strong><p>Preencha o formulário ao lado para publicar seu primeiro cupom.</p></div>}</div></section>
    </div>}
    {tab === 'inbox' && <InboxPanel messages={data.inbox || []} inboxConfig={data.config} onMarkRead={markInboxMessage} onReply={replyInboxMessage} onSetup={setupInboxInbound} />}
    {tab === 'queue' && <section className="panel table-panel"><div className="panel-heading"><div><h2>Fila de publicação</h2><p>{data.queue.filter((item) => item.status === 'pending').length} aguardando · {data.queue.filter((item) => item.status === 'failed').length} com falha</p></div>{data.queue.some((item) => item.status === 'failed') && <button className="queue-clear-failed" type="button" onClick={clearFailedQueue}>Excluir falhas</button>}</div><QueueTable queue={data.queue} onRemove={removeQueueItem} onForce={forceQueueItem} onRetry={retryQueueItem} /></section>}
    {tab === 'analytics' && <AnalyticsDashboard analytics={data.analytics} config={data.config} secrets={data.secrets} secretForm={secretForm} setSecretForm={setSecretForm} searchConsole={searchConsoleData} onConnect={connectSearchConsole} onRefreshSearchConsole={loadSearchConsole} setConfigField={setConfigField} />}
    {tab === 'sources' && <form className="settings-form source-layout" onSubmit={saveSources}>
      <section className="panel compact-panel">
        <div className="section-title"><div><span className="section-step">REGRAS GERAIS</span><h2>Como selecionar as ofertas</h2><p>Estas regras valem para todas as plataformas ativas.</p></div></div>
        <div className="settings-grid three-columns">
          <label>Desconto mínimo (%)<input type="number" min="0" max="95" value={data.config.minDiscount ?? 20} onChange={(event) => setData({ ...data, config: { ...data.config, minDiscount: event.target.value } })} /></label>
          <label>Buscar a cada quantos minutos<input type="number" min="5" value={data.config.collectionIntervalMinutes ?? 15} onChange={(event) => setData({ ...data, config: { ...data.config, collectionIntervalMinutes: event.target.value } })} /></label>
          <label className="toggle-card"><input type="checkbox" checked={Boolean(data.config.autoQueue)} onChange={(event) => setData({ ...data, config: { ...data.config, autoQueue: event.target.checked } })} /><span><strong>Fila automática</strong><small>Adicionar ofertas com link confirmado à fila.</small></span></label>
        </div>
      </section>
      <div className="source-cards">
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand mercado">ML</div><div><h2>Mercado Livre</h2><p>{data.secrets?.mercadoLivreConnected ? 'Conta conectada com renovação automática.' : 'Conecte sua aplicação oficial.'}</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableMercadoLivre)} onChange={(event) => setData({ ...data, config: { ...data.config, enableMercadoLivre: event.target.checked } })} /><span></span></label></div>
          <div className="source-card-body">

            <div className="ml-category-selector">
              <div className="ml-category-header">
                <span>
                  <strong>Categorias para coletar</strong>
                  <small>
                    Selecione os setores em que o PromoShop deve procurar produtos.
                  </small>
                </span>

                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const current = Array.isArray(data.config.mercadoLivreCategories)
                      ? data.config.mercadoLivreCategories
                      : [];

                    const next =
                      current.length === mercadoLivreCategories.length
                        ? []
                        : mercadoLivreCategories.map((category) => category.id);

                    setData({
                      ...data,
                      config: {
                        ...data.config,
                        mercadoLivreCategories: next
                      }
                    });
                  }}
                >
                  {(data.config.mercadoLivreCategories || []).length ===
                    mercadoLivreCategories.length
                    ? 'Desmarcar todas'
                    : 'Selecionar todas'}
                </button>
              </div>

              <div className="ml-category-grid">
                {mercadoLivreCategories.map((category) => {
                  const selected = Array.isArray(data.config.mercadoLivreCategories)
                    ? data.config.mercadoLivreCategories
                    : [];

                  const checked = selected.includes(category.id);

                  return (
                    <label className="ml-category-option" key={category.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const current = Array.isArray(
                            data.config.mercadoLivreCategories
                          )
                            ? data.config.mercadoLivreCategories
                            : [];

                          const next = event.target.checked
                            ? [...new Set([...current, category.id])]
                            : current.filter((id) => id !== category.id);

                          setData({
                            ...data,
                            config: {
                              ...data.config,
                              mercadoLivreCategories: next
                            }
                          });
                        }}
                      />

                      <span>{category.name}</span>
                    </label>
                  );
                })}
              </div>

              <small className="ml-category-count">
                {(data.config.mercadoLivreCategories || []).length} categorias selecionadas
              </small>
            </div>

            <label>
              Palavras-chave adicionais
              <textarea
                value={data.config.mercadoLivreQueries ?? ''}
                onChange={(event) =>
                  setData({
                    ...data,
                    config: {
                      ...data.config,
                      mercadoLivreQueries: event.target.value
                    }
                  })
                }
                placeholder="smartphone, notebook, air fryer, smartwatch"
              />
              <small>
                Opcional. Separe por vírgula. Essas buscas complementam as categorias selecionadas.
              </small>
            </label>

            <label>
              URL de redirecionamento
              <input
                value={
                  data.config.mercadoLivreRedirectUri ||
                  `${window.location.origin}/api/mercadolivre/callback`
                }
                onChange={(event) =>
                  setData({
                    ...data,
                    config: {
                      ...data.config,
                      mercadoLivreRedirectUri: event.target.value.trim()
                    }
                  })
                }
              />
              <small>
                Cadastre exatamente esta URL na aplicação do Mercado Livre.
              </small>
            </label>

            <label>
              Client ID
              <input
                value={secretForm.mercadoLivreClientId}
                onChange={(event) =>
                  setSecretForm({
                    ...secretForm,
                    mercadoLivreClientId: event.target.value.trim()
                  })
                }
                placeholder={
                  data.secrets?.mercadoLivreClientIdConfigured
                    ? 'Client ID configurado'
                    : 'Cole o Client ID'
                }
                autoComplete="off"
              />
            </label>

            <label>
              Client Secret
              <input
                type="password"
                value={secretForm.mercadoLivreClientSecret}
                onChange={(event) =>
                  setSecretForm({
                    ...secretForm,
                    mercadoLivreClientSecret: event.target.value
                  })
                }
                placeholder={
                  data.secrets?.mercadoLivreClientSecretConfigured
                    ? 'Secret configurado — digite para substituir'
                    : 'Cole o Client Secret'
                }
                autoComplete="new-password"
              />
              <small>A chave será criptografada no servidor.</small>
            </label>

            {data.secrets?.mercadoLivreConnected && (
              <div className="source-note">
                <strong>Conectado</strong>
                <span>
                  {data.secrets.mercadoLivreUserId
                    ? `Conta ${data.secrets.mercadoLivreUserId}. `
                    : ''}
                  O token será renovado automaticamente.
                </span>
              </div>
            )}

            <div className="affiliate-automation">
              <div className="affiliate-automation-head">
                <span>
                  <strong>Automação de links de afiliado</strong>
                  <small>
                    Permite transformar automaticamente os produtos encontrados em links
                    do Programa de Afiliados.
                  </small>
                </span>
              </div>

              <div className="source-note">
                <strong>
                  {data.secrets?.mercadoLivreAffiliateCookieConfigured &&
                    data.secrets?.mercadoLivreAffiliateCsrfTokenConfigured
                    ? 'Automação configurada'
                    : 'Configuração necessária'}
                </strong>

                <span>
                  Cookie:{' '}
                  {data.secrets?.mercadoLivreAffiliateCookieConfigured
                    ? 'configurado'
                    : 'não configurado'}
                  {' · '}
                  CSRF:{' '}
                  {data.secrets?.mercadoLivreAffiliateCsrfTokenConfigured
                    ? 'configurado'
                    : 'não configurado'}
                </span>
              </div>

              <label>
                Cookie da sessão de afiliados
                <textarea
                  value={secretForm.mercadoLivreAffiliateCookie}
                  onChange={(event) =>
                    setSecretForm({
                      ...secretForm,
                      mercadoLivreAffiliateCookie: event.target.value
                    })
                  }
                  placeholder={
                    data.secrets?.mercadoLivreAffiliateCookieConfigured
                      ? 'Cookie configurado — cole um novo somente para substituir'
                      : 'Cole o conteúdo completo do header Cookie'
                  }
                  autoComplete="off"
                />

                <small>
                  Copie o valor completo do header Cookie da solicitação createLink no
                  DevTools do Mercado Livre.
                </small>
              </label>

              <label>
                CSRF Token
                <input
                  type="password"
                  value={secretForm.mercadoLivreAffiliateCsrfToken}
                  onChange={(event) =>
                    setSecretForm({
                      ...secretForm,
                      mercadoLivreAffiliateCsrfToken: event.target.value
                    })
                  }
                  placeholder={
                    data.secrets?.mercadoLivreAffiliateCsrfTokenConfigured
                      ? 'CSRF configurado — digite para substituir'
                      : 'Cole o x-csrf-token'
                  }
                  autoComplete="new-password"
                />

                <small>
                  Use o valor do header x-csrf-token da solicitação createLink.
                </small>
              </label>

              <label>
                Tag do afiliado
                <input
                  value={secretForm.mercadoLivreAffiliateTag}
                  onChange={(event) =>
                    setSecretForm({
                      ...secretForm,
                      mercadoLivreAffiliateTag: event.target.value
                    })
                  }
                  placeholder="promoshop"
                  autoComplete="off"
                />

                <small>
                  Essa tag será enviada ao gerador de links. Exemplo: promoshop.
                </small>
              </label>

              <button
                className="button primary full"
                type="button"
                onClick={saveMercadoLivreAffiliate}
              >
                Salvar automação de afiliados
              </button>
            </div>

            <button
              className="button primary full"
              type="button"
              onClick={connectMercadoLivre}
            >
              {data.secrets?.mercadoLivreConnected
                ? 'Reconectar Mercado Livre'
                : 'Conectar Mercado Livre'}
            </button>

            {data.secrets?.mercadoLivreConnected && (
              <button
                className="button subtle full"
                type="button"
                onClick={testMercadoLivre}
              >
                Testar conexão do Mercado Livre
              </button>
            )}
          </div>
        </section>
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand shopee">S</div><div><h2>Shopee</h2><p>Open API de afiliados.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableShopee)} onChange={(event) => setData({ ...data, config: { ...data.config, enableShopee: event.target.checked } })} /><span></span></label></div>
          <div className="source-card-body"><label>Assuntos para buscar<textarea value={data.config.shopeeQueries ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, shopeeQueries: event.target.value } })} placeholder="eletrônicos, casa, beleza, moda" /><small>Separe por vírgula.</small></label><label>App ID<input value={secretForm.shopeeAppId} onChange={(event) => setSecretForm({ ...secretForm, shopeeAppId: event.target.value.trim() })} placeholder={data.secrets?.shopeeAppIdConfigured ? 'App ID configurado' : 'Cole o App ID'} autoComplete="off" /></label><label>App Secret<input type="password" value={secretForm.shopeeAppSecret} onChange={(event) => setSecretForm({ ...secretForm, shopeeAppSecret: event.target.value })} placeholder={data.secrets?.shopeeAppSecretConfigured ? 'Secret configurado — digite para substituir' : 'Cole o App Secret'} autoComplete="new-password" /></label><button className="button subtle full" type="button" onClick={testShopee}>Testar conexão da Shopee</button></div>
        </section>
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand aliexpress">AE</div><div><h2>AliExpress</h2><p>Standard API para Publishers.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableAliexpress)} onChange={(event) => setData({ ...data, config: { ...data.config, enableAliexpress: event.target.checked } })} /><span></span></label></div>
          <div className="source-note"><strong>Campanhas automáticas</strong><span>Coleta as campanhas ativas. Busca livre exige Advanced API.</span></div>
          <div className="source-card-body"><label>Tracking ID<input value={data.config.aliexpressTrackingId ?? 'promoshop'} onChange={(event) => setData({ ...data, config: { ...data.config, aliexpressTrackingId: event.target.value.trim() } })} placeholder="promoshop" /></label><label>App Key<input value={secretForm.aliexpressAppKey} onChange={(event) => setSecretForm({ ...secretForm, aliexpressAppKey: event.target.value.trim() })} placeholder={data.secrets?.aliexpressAppKeyConfigured ? 'App Key configurada' : 'Cole a App Key'} autoComplete="off" /></label><label>App Secret<input type="password" value={secretForm.aliexpressAppSecret} onChange={(event) => setSecretForm({ ...secretForm, aliexpressAppSecret: event.target.value })} placeholder={data.secrets?.aliexpressAppSecretConfigured ? 'Secret configurado — digite para substituir' : 'Cole o App Secret'} autoComplete="new-password" /></label><label>App Signature <small>(opcional)</small><input type="password" value={secretForm.aliexpressAppSignature} onChange={(event) => setSecretForm({ ...secretForm, aliexpressAppSignature: event.target.value })} placeholder={data.secrets?.aliexpressAppSignatureConfigured ? 'Signature configurada — digite para substituir' : 'Pode deixar vazio'} autoComplete="new-password" /></label><button className="button subtle full" type="button" onClick={testAliexpress}>Testar conexão do AliExpress</button></div>
        </section>
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand magalu">M</div><div><h2>Magalu</h2><p>Cadastro do programa de afiliados.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableMagalu)} onChange={(event) => setData({ ...data, config: { ...data.config, enableMagalu: event.target.checked } })} /><span></span></label></div>
          <div className="source-note"><strong>Busca segura pela sua vitrine</strong><span>O Magalu pode apresentar captcha para automações. Use o botão Magalu na busca manual para abrir sua loja, copie o link do produto e cadastre-o no formulário. Não simulamos uma API de seller.</span></div>
          <div className="source-card-body"><label>Endereço da loja (slug)<input value={data.config.magaluStoreSlug ?? 'magazinepromoshopsite'} onChange={(event) => setData({ ...data, config: { ...data.config, magaluStoreSlug: event.target.value.trim() } })} placeholder="magazinepromoshopsite" /><small>É a parte final de magazinevoce.com.br/magazinepromoshopsite/.</small></label><label>ID do afiliado<input value={secretForm.magaluAffiliateId} onChange={(event) => setSecretForm({ ...secretForm, magaluAffiliateId: event.target.value.trim() })} placeholder={data.secrets?.magaluAffiliateIdConfigured ? 'ID configurado' : 'Cole o ID do programa'} autoComplete="off" /></label><label>Chave ou token <small>(se fornecido)</small><input type="password" value={secretForm.magaluApiKey} onChange={(event) => setSecretForm({ ...secretForm, magaluApiKey: event.target.value })} placeholder={data.secrets?.magaluApiKeyConfigured ? 'Chave configurada — digite para substituir' : 'Cole a chave/token'} autoComplete="new-password" /></label><small>O cadastro fica criptografado. Não use a chave de seller em um campo de afiliado.</small></div>
        </section>
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand netshoes">N</div><div><h2>Netshoes</h2><p>Parceiro Netshoes / rede de afiliados.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableNetshoes)} onChange={(event) => setData({ ...data, config: { ...data.config, enableNetshoes: event.target.checked } })} /><span></span></label></div>
          <div className="source-note"><strong>Integração preparada</strong><span>O programa de afiliados entrega links e campanhas pelo portal parceiro. A API pública encontrada é de marketplace para sellers, não de afiliados.</span></div>
          <div className="source-card-body"><label>ID do afiliado<input value={secretForm.netshoesAffiliateId} onChange={(event) => setSecretForm({ ...secretForm, netshoesAffiliateId: event.target.value.trim() })} placeholder={data.secrets?.netshoesAffiliateIdConfigured ? 'ID configurado' : 'Cole o ID do programa'} autoComplete="off" /></label><label>Chave ou token <small>(se fornecido)</small><input type="password" value={secretForm.netshoesApiKey} onChange={(event) => setSecretForm({ ...secretForm, netshoesApiKey: event.target.value })} placeholder={data.secrets?.netshoesApiKeyConfigured ? 'Chave configurada — digite para substituir' : 'Cole a chave/token'} autoComplete="new-password" /></label><small>O cadastro fica criptografado. Não use o token de seller sem confirmar que ele é de afiliado.</small></div>
        </section>
      </div>
      <div className="form-footer"><span>As credenciais são armazenadas de forma protegida.</span><button className="button primary">Salvar todas as fontes</button></div>
    </form>}
    {tab === 'whatsapp' && <div className="whatsapp-admin-grid">
      <section className="panel connection-panel">
        <div className="connection-head"><div className="connection-summary"><span className={`connection-dot ${whatsapp.status || 'offline'}`}></span><div><small>STATUS DO PUBLICADOR</small><h2>{statusLabels[whatsapp.status] || 'Desconectado'}</h2><p>{whatsapp.message}</p></div></div><div className="connection-meta"><span><strong>{(whatsapp.groups || []).length}</strong> grupos encontrados</span><span><strong>{data.queue.filter((item) => item.status === 'pending').length}</strong> aguardando na fila</span></div><div className="connection-actions">
          <button
            className="button primary"
            type="button"
            onClick={reconnectWhatsapp}
          >
            Reconectar
          </button>

          <button
            className="button subtle"
            type="button"
            onClick={checkWhatsappConnection}
          >
            Verificar conexão
          </button>

          <button
            className="button subtle"
            type="button"
            onClick={stopWhatsapp}
          >
            Desconectar
          </button>
        </div></div>
        {whatsapp.status !== 'connected' && <div className="phone-pairing"><label>Número com país e DDD<input inputMode="numeric" autoComplete="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value.replace(/\D/g, ''))} placeholder="5511999999999" /><small>Exemplo: 55 + DDD + número. Ele não será salvo.</small></label><div className="connection-actions"><button className="button primary" type="button" onClick={() => startWhatsapp('phone')}>Conectar pelo número</button><button className="button subtle" type="button" onClick={() => startWhatsapp('qr')}>Usar QR Code</button></div></div>}
        {whatsapp.pairingCode && <div className="pairing-box"><span className="pairing-code">{formattedPairingCode}</span><div><strong>Digite este código no WhatsApp</strong><p>No celular: Aparelhos conectados → Conectar aparelho → Conectar com número de telefone.</p></div></div>}
        {whatsapp.qrDataUrl && <div className="qr-box"><img src={whatsapp.qrDataUrl} alt="QR Code para conectar o WhatsApp" /><div><strong>Leia este QR Code</strong><p>No celular, abra WhatsApp → Aparelhos conectados → Conectar aparelho.</p></div></div>}
      </section>
      <form className="settings-form whatsapp-settings" onSubmit={saveConfig}>
        <div className="whatsapp-settings-grid">
          <section className="panel setting-section groups-section"><div className="section-title"><div><span className="section-step">DESTINOS</span><h2>Grupos de publicação</h2><p>Marque todos os grupos que receberão cada oferta.</p></div></div>{whatsapp.status !== 'connected' && !(whatsapp.groups || []).length && <div className="setup-hint"><strong>Conecte o WhatsApp primeiro</strong><p>Depois da conexão, seus grupos aparecerão aqui.</p></div>}<div className="group-selector"><div className="group-options">{(whatsapp.groups || []).map((group) => { const configured = Array.isArray(data.config.whatsappGroups) && data.config.whatsappGroups.length ? data.config.whatsappGroups : (data.config.whatsappGroupId ? [{ id: data.config.whatsappGroupId, name: data.config.whatsappGroupName }] : []); const checked = configured.some((selected) => selected.id === group.id); return <label className="group-option" key={group.id}><input type="checkbox" checked={checked} onChange={(event) => { const current = configured.filter((selected) => selected.id !== group.id); const next = event.target.checked ? [...current, group] : current; setData({ ...data, config: { ...data.config, whatsappGroups: next, whatsappGroupId: next[0]?.id || '', whatsappGroupName: next[0]?.name || '' } }); }} /><span>{group.name}</span></label>; })}{!(whatsapp.groups || []).length && <small>Os grupos serão carregados após a conexão.</small>}</div><small>{(() => { const count = (Array.isArray(data.config.whatsappGroups) && data.config.whatsappGroups.length ? data.config.whatsappGroups : (data.config.whatsappGroupId ? [{ id: data.config.whatsappGroupId }] : [])).length; return `${count} de ${(whatsapp.groups || []).length} grupo${(whatsapp.groups || []).length === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}`; })()}</small></div><div className="community-settings"><label className="toggle-card"><input type="checkbox" checked={data.config.whatsappCommunityEnabled !== false} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappCommunityEnabled: event.target.checked } })} /><span><strong>Enviar também para a comunidade geral</strong><small>Inclui o grupo sem código, como “PromoShop - Ofertas ⚡”.</small></span></label><label>Nome da comunidade<input value={data.config.whatsappCommunityName ?? 'PromoShop - Ofertas'} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappCommunityName: event.target.value } })} placeholder="PromoShop - Ofertas" /><small>Pontuação e emojis podem variar; o sistema reconhece essas variações.</small></label></div><label className="field-separator">Link público do grupo<input type="url" value={data.config.whatsappUrl === '#' ? '' : data.config.whatsappUrl ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappUrl: event.target.value } })} placeholder="https://chat.whatsapp.com/..." /><small>Usado somente no botão do site público.</small></label></section>
          <section className="panel setting-section"><div className="section-title"><div><span className="section-step">AGENDA</span><h2>Horários e frequência</h2><p>Defina quando a fila automática pode publicar.</p></div></div><div className="settings-grid"><label>Começar às<input type="time" value={data.config.publishingStart ?? '08:00'} onChange={(event) => setData({ ...data, config: { ...data.config, publishingStart: event.target.value } })} /></label><label>Parar às<input type="time" value={data.config.publishingEnd ?? '23:00'} onChange={(event) => setData({ ...data, config: { ...data.config, publishingEnd: event.target.value } })} /></label><label>Intervalo<select value={data.config.whatsappIntervalMinutes ?? 15} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappIntervalMinutes: Number(event.target.value) } })}>{[5, 10, 15, 20, 25, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutos</option>)}</select><small>Não afeta “Publicar agora”.</small></label><label>Máximo por hora<input type="number" min="1" value={data.config.whatsappMaxPerHour ?? 10} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappMaxPerHour: event.target.value } })} /></label><label>Máximo por dia<input type="number" min="1" value={data.config.maxPostsPerDay ?? 10} onChange={(event) => setData({ ...data, config: { ...data.config, maxPostsPerDay: event.target.value } })} /></label><label className="toggle-card"><input type="checkbox" checked={Boolean(data.config.whatsappHeadless)} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappHeadless: event.target.checked } })} /><span><strong>Modo oculto</strong><small>Publicar sem abrir a janela do WhatsApp.</small></span></label><label className="toggle-card"><input type="checkbox" checked={data.config.whatsappAutoStart !== false} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappAutoStart: event.target.checked } })} /><span><strong>Iniciar automaticamente</strong><small>Reconectar o publicador quando o servidor reiniciar.</small></span></label></div></section>
        </div>
        <section className="panel setting-section message-section"><div className="section-title"><div><span className="section-step">INTELIGÊNCIA ARTIFICIAL</span><h2>Texto exclusivo para cada oferta</h2><p>A IA externa cria a mensagem somente quando o produto estiver prestes a ser publicado.</p></div></div><div className="ai-settings-grid"><label className="toggle-card ai-toggle"><input type="checkbox" checked={Boolean(data.config.aiEnabled)} onChange={(event) => setData({ ...data, config: { ...data.config, aiEnabled: event.target.checked } })} /><span><strong>Criar textos com IA</strong><small>Se a IA falhar, a publicação aguardará uma nova tentativa.</small></span></label><label>Provedor<select value={data.config.aiProvider ?? 'gemini'} onChange={(event) => { const models = { gemini: 'gemini-3.5-flash-lite', groq: 'openai/gpt-oss-20b', ollama: 'qwen2.5:3b' }; setData({ ...data, config: { ...data.config, aiProvider: event.target.value, aiModel: models[event.target.value] } }); }}><option value="gemini">Gemini (gratuito — recomendado)</option><option value="groq">Groq (externa)</option><option value="ollama">Ollama local</option></select><small>As chaves ficam criptografadas no servidor.</small></label><label>Modelo<input value={data.config.aiModel ?? 'gemini-3.5-flash-lite'} onChange={(event) => setData({ ...data, config: { ...data.config, aiModel: event.target.value } })} /><small>{data.config.aiProvider === 'gemini' ? 'Modelo gratuito recomendado: gemini-3.5-flash-lite.' : data.config.aiProvider === 'groq' ? 'Modelo recomendado: openai/gpt-oss-20b.' : 'Modelo local instalado no Ollama.'}</small></label>{data.config.aiProvider === 'gemini' && <label>Chave do Gemini<input type="password" value={secretForm.geminiApiKey} onChange={(event) => setSecretForm({ ...secretForm, geminiApiKey: event.target.value })} placeholder={data.secrets?.geminiApiKeyConfigured ? 'Chave configurada — digite para substituir' : 'Cole a chave do Google AI Studio'} autoComplete="new-password" /><small>{data.secrets?.geminiApiKeyConfigured ? `Chave salva com final ${data.secrets.geminiApiKeyEnding || '----'}${data.secrets.geminiApiKeyFormatValid === false ? ' — parece incompleta' : ''}.` : 'Use Copiar chave de API no AI Studio; não copie o nome nem o número do projeto.'}</small></label>}<label>
          Chave da OpenAI

          <input
            type="password"
            value={secretForm.openaiApiKey}
            onChange={(event) =>
              setSecretForm({
                ...secretForm,
                openaiApiKey: event.target.value
              })
            }
            placeholder={
              data.secrets?.openaiApiKeyConfigured
                ? 'Chave configurada — digite para substituir'
                : 'Cole a chave da OpenAI'
            }
            autoComplete="new-password"
          />

          <small>
            {data.secrets?.openaiApiKeyConfigured
              ? `Chave salva com final ${data.secrets.openaiApiKeyEnding || '----'
              }${data.secrets.openaiApiKeyFormatValid === false
                ? ' — parece inválida'
                : ''
              }.`
              : 'Cole sua chave secreta da API da OpenAI.'}
          </small>
        </label>
          <label>
            Modelo OpenAI

            <input
              value={
                data.config.aiModels?.openai ?? ''
              }
              onChange={(event) =>
                setData({
                  ...data,
                  config: {
                    ...data.config,

                    aiModels: {
                      ...(data.config.aiModels || {}),
                      openai: event.target.value
                    }
                  }
                })
              }
              placeholder="gpt-5-mini"
            />

            <small>
              Modelo usado quando o Gemini falhar e o sistema chamar a OpenAI.
            </small>
          </label>
          {data.config.aiProvider === 'groq' && <label>Chave da Groq<input type="password" value={secretForm.aiApiKey} onChange={(event) => setSecretForm({ ...secretForm, aiApiKey: event.target.value })} placeholder={data.secrets?.aiApiKeyConfigured ? 'Chave configurada — digite para substituir' : 'Cole a chave da API'} autoComplete="new-password" /><small>{data.secrets?.aiApiKeyConfigured ? `Chave salva com final ${data.secrets.aiApiKeyEnding || '----'}${data.secrets.aiApiKeyFormatValid === false ? ' — formato inválido' : ''}.` : 'Cole o valor secreto completo, começando com gsk_.'}</small></label>}<label>Estilo do texto<select value={data.config.aiTone ?? 'varied'} onChange={(event) => setData({ ...data, config: { ...data.config, aiTone: event.target.value } })}><option value="varied">Variado automaticamente</option><option value="seller">Vendedor e confiável</option><option value="direct">Direto e objetivo</option><option value="friendly">Amigável e natural</option><option value="urgent">Urgência responsável</option><option value="premium">Elegante e premium</option><option value="playful">Divertido e descontraído</option><option value="story">Mini-história cotidiana</option><option value="minimal">Minimalista</option></select></label><label className="ai-instructions">Instruções para a IA<textarea value={data.config.aiInstructions ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, aiInstructions: event.target.value } })} placeholder="Ex.: Use poucos emojis e destaque a economia." /></label>{data.config.aiProvider === 'ollama' && <details className="advanced-ai"><summary>Configuração avançada</summary><label>Endereço do Ollama<input value={data.config.aiOllamaUrl ?? 'http://127.0.0.1:11434'} onChange={(event) => setData({ ...data, config: { ...data.config, aiOllamaUrl: event.target.value } })} /></label></details>}<button className="button subtle" type="button" onClick={testAi}>Salvar e testar IA</button></div>{aiPreview && <div className="ai-preview"><span>PRÉVIA DA MENSAGEM</span><pre>{aiPreview}</pre></div>}<div className="fallback-template"><div><strong>Estrutura preferida da mensagem</strong><small>Serve como texto de segurança e referência visual.</small></div><label>Modelo da mensagem<textarea value={data.config.messageTemplate ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, messageTemplate: event.target.value } })} /><small>Campos disponíveis: {'{title}'}, {'{benefit}'}, {'{originalPrice}'}, {'{price}'}, {'{discount}'}, {'{shipping}'} e {'{link}'}.</small></label></div></section>
        <section className="panel setting-section audience-manager">

          <div className="section-title">
            <div>
              <span className="section-step">
                PÚBLICOS
              </span>

              <h2>
                Públicos e grupos
              </h2>

              <p>
                Configure quais produtos pertencem a cada grupo
                e informe o link para entrada.
              </p>
            </div>

            <button
              className="button subtle"
              type="button"
              onClick={addAudience}
            >
              + Adicionar público
            </button>
          </div>


          <div className="audience-list">

            {(data.config.whatsappAudiences || [])
              .map((audience, index) => (

                <article
                  className="audience-card"
                  key={`${audience.code}-${index}`}
                >

                  <div className="audience-card-head">

                    <span className="audience-code">
                      {audience.code}
                    </span>

                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={audience.enabled !== false}
                        onChange={(event) =>
                          updateAudience(index, {
                            enabled: event.target.checked
                          })
                        }
                      />

                      <span></span>
                    </label>

                  </div>


                  <label>
                    Código do público

                    <input
                      value={audience.code || ''}
                      disabled={
                        audience.code === 'G01' ||
                        audience.code === 'G10'
                      }
                      onChange={(event) =>
                        updateAudience(index, {
                          code: event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, '')
                        })
                      }
                    />

                    <small>
                      O grupo do WhatsApp deve terminar com este
                      código. Ex.: | {audience.code}
                    </small>
                  </label>


                  <label>
                    Nome

                    <input
                      value={audience.name || ''}
                      onChange={(event) =>
                        updateAudience(index, {
                          name: event.target.value
                        })
                      }
                      placeholder="Ex.: Tecnologia & Games"
                    />
                  </label>


                  <label>
                    Link para entrar no grupo

                    <input
                      type="url"
                      value={audience.whatsappLink || ''}
                      onChange={(event) =>
                        updateAudience(index, {
                          whatsappLink:
                            event.target.value.trim()
                        })
                      }
                      placeholder="https://chat.whatsapp.com/..."
                    />
                  </label>


                  {audience.code !== 'G01' &&
                    audience.code !== 'G10' && (
                      <label>
                        Perfil do público

                        <select
                          value={audience.profile || 'general'}
                          onChange={(event) =>
                            updateAudience(index, {
                              profile: event.target.value
                            })
                          }
                        >
                          <option value="general">Geral</option>
                          <option value="female">Somente feminino</option>
                        </select>

                        <small>
                          No perfil feminino, produtos masculinos são barrados mesmo que a IA os classifique neste grupo.
                        </small>
                      </label>
                    )}

                  <KeywordEditor
                    label="Palavras-chave"
                    value={audience.keywords}
                    onChange={(keywords) => updateAudience(index, { keywords })}
                    placeholder="Digite uma palavra ou cole uma lista"
                    help={audience.code === 'G01'
                      ? 'Se a lista ficar vazia, este grupo recebe ofertas que não combinarem com outro público. Com palavras, recebe apenas as ofertas gerais que também combinarem com elas.'
                      : audience.code === 'G10'
                        ? 'Se a lista ficar vazia, basta atingir o desconto mínimo. Com palavras, a oferta também precisa combinar com pelo menos uma delas.'
                        : 'Você pode adicionar várias palavras separadas por vírgula, ponto e vírgula ou linha.'}
                  />

                  <KeywordEditor
                    label="Termos bloqueados"
                    value={audience.blockedKeywords}
                    onChange={(blockedKeywords) => updateAudience(index, { blockedKeywords })}
                    placeholder="Ex.: masculino, barba, menino"
                    help="Se o anúncio contiver um destes termos, ele não será enviado para este público."
                  />


                  {audience.code === 'G10' && (

                    <label>
                      Desconto mínimo para entrar neste grupo

                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={audience.minDiscount || 40}
                        onChange={(event) =>
                          updateAudience(index, {
                            minDiscount:
                              Number(event.target.value)
                          })
                        }
                      />

                      <small>
                        Atualmente: ofertas com pelo menos{' '}
                        {audience.minDiscount || 40}% OFF.
                      </small>
                    </label>

                  )}


                  {audience.code !== 'G01' &&
                    audience.code !== 'G10' && (

                      <button
                        className="button danger-button"
                        type="button"
                        onClick={() =>
                          removeAudience(index)
                        }
                      >
                        Excluir público
                      </button>

                    )}

                </article>

              ))}

          </div>

        </section>
        <div className="form-footer"><span>As alterações entram em vigor após salvar.</span><button className="button primary">Salvar grupos e regras</button></div>
      </form>
    </div>}
    {tab === 'health' && <div className="health-layout">
      <section className={`panel health-summary ${data.systemHealth?.status || 'attention'}`}><div><span className="section-step">DIAGNÓSTICO</span><h2>{data.systemHealth?.status === 'healthy' ? 'Sistema funcionando normalmente' : data.systemHealth?.status === 'critical' ? 'O sistema precisa de atenção imediata' : 'Há itens para revisar'}</h2><p>Verificação atualizada em {data.systemHealth?.checkedAt ? new Date(data.systemHealth.checkedAt).toLocaleString('pt-BR') : '—'}.</p></div><button className="button subtle" type="button" onClick={() => load()}>Verificar novamente</button></section>
      <div className="health-check-grid">{(data.systemHealth?.checks || []).map((check) => <article className={`panel health-check ${check.ok ? 'ok' : 'warning'}`} key={check.id}><span>{check.ok ? '✓' : '!'}</span><div><h3>{check.label}</h3><p>{check.detail}</p></div></article>)}</div>
      <section className="panel backup-panel"><div><span className="section-step">MANUTENÇÃO SEGURA</span><h2>Links, configurações e cupons</h2><p>Verifique os links conhecidos em pequenos lotes ou baixe uma cópia operacional. Por privacidade e segurança, o backup não inclui senhas, chaves de API, sessão do WhatsApp, mensagens de contato, comprovantes de consentimento ou identificadores de audiência.</p></div><div className="backup-actions"><button className="button subtle" type="button" onClick={checkOfferLinks}>Verificar links</button><button className="button primary" type="button" onClick={downloadBackup}>Baixar backup</button><button className="button subtle" type="button" onClick={() => backupInputRef.current?.click()}>Restaurar backup</button><input ref={backupInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={restoreBackup} /></div></section>
      <section className="panel health-privacy-note"><strong>Importante</strong><p>O disco persistente do Render conserva os dados entre reinícios. Durante uma nova publicação, esse tipo de disco pode causar uma breve indisponibilidade; o painel diferencia isso de falhas permanentes.</p></section>
    </div>}
    {tab === 'settings' && <form className="site-settings-layout" onSubmit={saveConfig}>
      <section className="panel settings-section">
        <div className="section-title"><div><span className="section-step">IDENTIDADE</span><h2>Conteúdo e aparência</h2><p>Textos principais exibidos no site público.</p></div></div>
        <div className="settings-grid">
          <label>Nome do site<input value={data.config.brandName ?? ''} onChange={(event) => setConfigField('brandName', event.target.value)} /></label>
          <label>Cor principal<input type="color" value={data.config.primaryColor ?? '#1269f3'} onChange={(event) => setConfigField('primaryColor', event.target.value)} /></label>
          <label className="wide-field">Título principal<input value={data.config.heroTitle ?? ''} onChange={(event) => setConfigField('heroTitle', event.target.value)} /></label>
          <label className="wide-field">Texto principal<textarea value={data.config.heroText ?? ''} onChange={(event) => setConfigField('heroText', event.target.value)} /></label>
          <label className="wide-field">Aviso geral de afiliado<textarea value={data.config.disclosure ?? ''} onChange={(event) => setConfigField('disclosure', event.target.value)} /></label>
          <label>Identificação nas ofertas<input value={data.config.affiliateDisclosureLabel ?? ''} onChange={(event) => setConfigField('affiliateDisclosureLabel', event.target.value)} /></label>
          <label>E-mail público<input type="email" value={data.config.contactEmail ?? ''} onChange={(event) => setConfigField('contactEmail', event.target.value)} /></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.mobileCompactMenu !== false} onChange={(event) => setConfigField('mobileCompactMenu', event.target.checked)} /><span><strong>Menu compacto no celular</strong><small>Evita links amontoados em telas menores.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.showOfferUpdatedAt !== false} onChange={(event) => setConfigField('showOfferUpdatedAt', event.target.checked)} /><span><strong>Mostrar atualização</strong><small>Exibe quando a oferta foi revisada.</small></span></label>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-title"><div><span className="section-step">SEO</span><h2>Busca e compartilhamento</h2><p>Informações usadas pelo Google e pelas prévias de redes sociais.</p></div></div>
        <div className="settings-grid">
          <label className="wide-field">Endereço oficial do site<input type="url" value={data.config.canonicalUrl ?? ''} onChange={(event) => setConfigField('canonicalUrl', event.target.value)} placeholder="https://promoshop.jhonatafaraujo.com.br" /></label>
          <label className="wide-field">Nome do site no Google<input maxLength={60} value={data.config.seoSiteName ?? ''} onChange={(event) => setConfigField('seoSiteName', event.target.value)} /><small>Nome preferido exibido acima do endereço. O Google pode levar algum tempo para atualizar.</small></label>
          <label className="wide-field">Título para buscadores<input maxLength={70} value={data.config.seoTitle ?? ''} onChange={(event) => setConfigField('seoTitle', event.target.value)} /><small>{String(data.config.seoTitle || '').length}/70 caracteres</small></label>
          <label className="wide-field">Descrição para buscadores<textarea maxLength={180} value={data.config.seoDescription ?? ''} onChange={(event) => setConfigField('seoDescription', event.target.value)} /><small>{String(data.config.seoDescription || '').length}/180 caracteres</small></label>
          <label className="wide-field">Palavras-chave<input value={data.config.seoKeywords ?? ''} onChange={(event) => setConfigField('seoKeywords', event.target.value)} /></label>
          <label className="wide-field">Imagem de compartilhamento<input type="url" value={data.config.seoImageUrl ?? ''} onChange={(event) => setConfigField('seoImageUrl', event.target.value)} placeholder="https://.../imagem.jpg" /></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.seoIndexingEnabled !== false} onChange={(event) => setConfigField('seoIndexingEnabled', event.target.checked)} /><span><strong>Permitir indexação</strong><small>Autoriza buscadores a listar o site.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.seoStructuredDataEnabled !== false} onChange={(event) => setConfigField('seoStructuredDataEnabled', event.target.checked)} /><span><strong>Dados estruturados</strong><small>Identifica o site e a organização para buscadores.</small></span></label>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-title"><div><span className="section-step">QUALIDADE</span><h2>Ofertas públicas</h2><p>Filtre itens incompletos, antigos ou potencialmente inadequados.</p></div></div>
        <div className="settings-grid">
          <label>Ofertas por carregamento<input type="number" min="6" max="60" value={data.config.publicOfferPageSize ?? 24} onChange={(event) => setConfigField('publicOfferPageSize', Number(event.target.value))} /></label>
          <label>Idade máxima da oferta (dias)<input type="number" min="1" max="365" value={data.config.publicOfferMaxAgeDays ?? 45} onChange={(event) => setConfigField('publicOfferMaxAgeDays', Number(event.target.value))} /></label>
          <label>Nota mínima de qualidade<input type="number" min="0" max="100" value={data.config.qualityMinimumScore ?? 55} onChange={(event) => setConfigField('qualityMinimumScore', Number(event.target.value))} /></label>
          <label>Tamanho máximo do título<input type="number" min="40" max="500" value={data.config.qualityMaxTitleLength ?? 180} onChange={(event) => setConfigField('qualityMaxTitleLength', Number(event.target.value))} /></label>
          <label>Links por verificação<input type="number" min="1" max="50" value={data.config.linkCheckBatchSize ?? 20} onChange={(event) => setConfigField('linkCheckBatchSize', Number(event.target.value))} /></label>
          <label>Peso do desconto<input type="number" min="0" max="100" value={data.config.rankingDiscountWeight ?? 35} onChange={(event) => setConfigField('rankingDiscountWeight', Number(event.target.value))} /></label>
          <label>Peso da novidade<input type="number" min="0" max="100" value={data.config.rankingFreshnessWeight ?? 25} onChange={(event) => setConfigField('rankingFreshnessWeight', Number(event.target.value))} /></label>
          <label>Peso da qualidade<input type="number" min="0" max="100" value={data.config.rankingQualityWeight ?? 25} onChange={(event) => setConfigField('rankingQualityWeight', Number(event.target.value))} /></label>
          <label>Peso dos cliques<input type="number" min="0" max="100" value={data.config.rankingClicksWeight ?? 15} onChange={(event) => setConfigField('rankingClicksWeight', Number(event.target.value))} /></label>
          <label className="wide-field">Termos bloqueados<input value={data.config.qualityBlockedTerms ?? ''} onChange={(event) => setConfigField('qualityBlockedTerms', event.target.value)} /><small>Separe por vírgula. Itens com esses termos perdem qualidade.</small></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.qualityFilterEnabled !== false} onChange={(event) => setConfigField('qualityFilterEnabled', event.target.checked)} /><span><strong>Filtro de qualidade</strong><small>Oculta ofertas abaixo da nota mínima.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.staleOffersHidden !== false} onChange={(event) => setConfigField('staleOffersHidden', event.target.checked)} /><span><strong>Ocultar ofertas antigas</strong><small>Usa o limite de idade definido acima.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.qualityRequireImage !== false} onChange={(event) => setConfigField('qualityRequireImage', event.target.checked)} /><span><strong>Exigir imagem segura</strong><small>Considera apenas imagens com HTTPS.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.qualityRequireHttpsLink !== false} onChange={(event) => setConfigField('qualityRequireHttpsLink', event.target.checked)} /><span><strong>Exigir link HTTPS</strong><small>Ajuda a evitar destinos inseguros.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.linkCheckEnabled !== false} onChange={(event) => setConfigField('linkCheckEnabled', event.target.checked)} /><span><strong>Verificação de links</strong><small>Habilita o monitor para domínios conhecidos.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.linkCheckAutoPause === true} onChange={(event) => setConfigField('linkCheckAutoPause', event.target.checked)} /><span><strong>Pausar link quebrado</strong><small>Só pausa após resposta definitiva 404 ou 410.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.smartRankingEnabled !== false} onChange={(event) => setConfigField('smartRankingEnabled', event.target.checked)} /><span><strong>Ordem inteligente</strong><small>Equilibra desconto, novidade, qualidade e interesse.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.duplicateGroupingEnabled !== false} onChange={(event) => setConfigField('duplicateGroupingEnabled', event.target.checked)} /><span><strong>Agrupar duplicados</strong><small>Evita repetir o mesmo produto na vitrine.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.rankingDiversityEnabled !== false} onChange={(event) => setConfigField('rankingDiversityEnabled', event.target.checked)} /><span><strong>Diversificar lojas</strong><small>Evita uma sequência longa da mesma loja.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.publicAdvancedFiltersEnabled !== false} onChange={(event) => setConfigField('publicAdvancedFiltersEnabled', event.target.checked)} /><span><strong>Filtros avançados</strong><small>Preço, desconto e frete grátis no site.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.favoritesEnabled !== false} onChange={(event) => setConfigField('favoritesEnabled', event.target.checked)} /><span><strong>Favoritos</strong><small>Salvos somente no navegador do visitante.</small></span></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.assistantEnabled !== false} onChange={(event) => setConfigField('assistantEnabled', event.target.checked)} /><span><strong>Assistente de compras</strong><small>Conversa, recomenda produtos ativos e indica o grupo adequado.</small></span></label>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-title"><div><span className="section-step">PRIVACIDADE E LGPD</span><h2>Medição e retenção</h2><p>O site mede acessos e cliques somente após autorização.</p></div></div>
        <div className="settings-grid">
          <label>Identificador de audiência (dias)<input type="number" min="1" max="730" value={data.config.analyticsVisitorRetentionDays ?? 365} onChange={(event) => setConfigField('analyticsVisitorRetentionDays', Number(event.target.value))} /></label>
          <label>Resumo diário (dias)<input type="number" min="1" max="730" value={data.config.analyticsDailyRetentionDays ?? 120} onChange={(event) => setConfigField('analyticsDailyRetentionDays', Number(event.target.value))} /></label>
          <label>Mensagens de contato (meses)<input type="number" min="1" max="60" value={data.config.contactRetentionMonths ?? 12} onChange={(event) => { const value = Number(event.target.value); setConfigField('contactRetentionMonths', value); setConfigField('legalContactRetentionMonths', value); }} /></label>
          <label>Comprovantes de escolha (anos)<input type="number" min="1" max="10" value={data.config.consentReceiptRetentionYears ?? 5} onChange={(event) => { const value = Number(event.target.value); setConfigField('consentReceiptRetentionYears', value); setConfigField('legalConsentRetentionYears', value); }} /></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.clickAnalyticsEnabled !== false} onChange={(event) => setConfigField('clickAnalyticsEnabled', event.target.checked)} /><span><strong>Medir cliques autorizados</strong><small>Registra somente totais anônimos após consentimento.</small></span></label>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-title"><div><span className="section-step">INFORMAÇÕES LEGAIS</span><h2>Responsável e políticas</h2><p>Ao mudar informações relevantes, atualize também a versão da política.</p></div></div>
        <div className="settings-grid">
          <label>Nome do responsável<input value={data.config.legalResponsibleName ?? ''} onChange={(event) => setConfigField('legalResponsibleName', event.target.value)} /></label>
          <label>Forma de atuação<input value={data.config.legalResponsibleType ?? ''} onChange={(event) => setConfigField('legalResponsibleType', event.target.value)} /></label>
          <label>Cidade e estado<input value={data.config.legalCityState ?? ''} onChange={(event) => setConfigField('legalCityState', event.target.value)} /></label>
          <label>E-mail de privacidade<input type="email" value={data.config.legalPrivacyEmail ?? ''} onChange={(event) => setConfigField('legalPrivacyEmail', event.target.value)} /></label>
          <label>Prazo de resposta (dias úteis)<input type="number" min="1" max="30" value={data.config.legalResponseBusinessDays ?? 5} onChange={(event) => setConfigField('legalResponseBusinessDays', Number(event.target.value))} /></label>
          <label>Versão das políticas<input value={data.config.legalPolicyVersion ?? ''} onChange={(event) => setConfigField('legalPolicyVersion', event.target.value)} placeholder="2026-08-23-v3" /><small>Use AAAA-MM-DD-vN. Uma nova versão pede nova escolha de privacidade.</small></label>
          <label className="wide-field">Programas de afiliados<input value={data.config.legalAffiliatePrograms ?? ''} onChange={(event) => setConfigField('legalAffiliatePrograms', event.target.value)} /></label>
          <label className="wide-field">Texto adicional em Sobre nós<textarea maxLength={3000} value={data.config.legalAboutCustomText ?? ''} onChange={(event) => setConfigField('legalAboutCustomText', event.target.value)} placeholder="Opcional. O texto obrigatório de transparência permanece atualizado automaticamente." /></label>
          <label className="wide-field">Texto adicional em Fale Conosco<textarea maxLength={3000} value={data.config.legalContactCustomText ?? ''} onChange={(event) => setConfigField('legalContactCustomText', event.target.value)} /></label>
          <label className="wide-field">Texto adicional nos Termos<textarea maxLength={3000} value={data.config.legalTermsCustomText ?? ''} onChange={(event) => setConfigField('legalTermsCustomText', event.target.value)} /></label>
          <label className="wide-field">Texto adicional em Privacidade<textarea maxLength={3000} value={data.config.legalPrivacyCustomText ?? ''} onChange={(event) => setConfigField('legalPrivacyCustomText', event.target.value)} /><small>Use para informações específicas. As cláusulas essenciais continuam automáticas para evitar omissões legais.</small></label>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-title"><div><span className="section-step">MONITORAMENTO</span><h2>Limites de atenção</h2><p>Parâmetros usados para destacar problemas operacionais no painel.</p></div></div>
        <div className="settings-grid">
          <label>E-mail para alertas<input type="email" value={data.config.monitoringEmail ?? ''} onChange={(event) => setConfigField('monitoringEmail', event.target.value)} /></label>
          <label>WhatsApp sem resposta (minutos)<input type="number" min="1" max="120" value={data.config.monitoringWhatsappMinutes ?? 5} onChange={(event) => setConfigField('monitoringWhatsappMinutes', Number(event.target.value))} /></label>
          <label>Coleta atrasada (horas)<input type="number" min="1" max="168" value={data.config.monitoringCollectionHours ?? 6} onChange={(event) => setConfigField('monitoringCollectionHours', Number(event.target.value))} /></label>
          <label>Falhas toleradas na fila<input type="number" min="1" max="500" value={data.config.monitoringFailedQueueLimit ?? 10} onChange={(event) => setConfigField('monitoringFailedQueueLimit', Number(event.target.value))} /></label>
          <label className="toggle-card"><input type="checkbox" checked={data.config.monitoringEnabled !== false} onChange={(event) => setConfigField('monitoringEnabled', event.target.checked)} /><span><strong>Monitoramento ativo</strong><small>Exibe avisos quando os limites forem ultrapassados.</small></span></label>
        </div>
      </section>

      <div className="settings-save-bar"><div><strong>Revise antes de salvar</strong><span>As alterações públicas entram em vigor imediatamente.</span></div><button className="button primary">Salvar site e políticas</button></div>
    </form>}
    {tab === 'security' && <form className="panel settings-form narrow-panel" onSubmit={saveSecurity}><h2>Acesso administrativo</h2><p className="panel-intro">As credenciais são criptografadas no computador e nunca são enviadas ao navegador público.</p><div className="settings-grid"><label>Usuário administrador<input required value={secretForm.adminUser || data.secrets?.adminUser || 'admin'} onChange={(event) => setSecretForm({ ...secretForm, adminUser: event.target.value })} autoComplete="off" /></label><label>Nova senha<input type="password" minLength="12" value={secretForm.adminPassword} onChange={(event) => setSecretForm({ ...secretForm, adminPassword: event.target.value })} placeholder="Deixe vazio para manter a atual" autoComplete="new-password" /></label></div><button className="button primary">Atualizar acesso</button></form>}
    {tab === 'logs' && <section className="panel"><h2>Registro de atividades</h2><div className="logs">{data.logs.map((log) => <div key={log.id}><time>{new Date(log.createdAt).toLocaleString('pt-BR')}</time><span className={log.level}>{log.message}</span></div>)}</div></section>}
  </main>{dialog && <div className="modal-backdrop" onMouseDown={() => setDialog(null)}><section className={`app-modal ${dialog.type === 'delete-offer' ? 'danger-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>{dialog.type === 'affiliate-link' ? <form onSubmit={confirmAffiliateLink}><div className="modal-icon link-icon">↗</div><div className="modal-heading"><span>VINCULAR OFERTA</span><h2 id="modal-title">Adicionar link de afiliado</h2><p>Cole o link gerado pela ferramenta oficial para liberar esta oferta.</p></div><div className="modal-product"><img src={dialog.offer?.image} alt="" /><span><strong>{dialog.offer?.title}</strong><small>{dialog.offer?.store} · {money.format(Number(dialog.offer?.price || 0))}</small></span></div><label>Link de afiliado<input autoFocus required type="url" value={dialog.value || ''} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} placeholder="https://..." /><small>O link comum está preenchido apenas como referência. Substitua pelo link de afiliado.</small></label><div className="modal-actions"><button className="button subtle" type="button" onClick={() => setDialog(null)}>Cancelar</button><button className="button primary" type="submit">Confirmar link</button></div></form> : <div><div className="modal-icon delete-icon">×</div><div className="modal-heading"><span>EXCLUIR OFERTA</span><h2 id="modal-title">Tem certeza?</h2><p>A oferta será removida do painel. Esta ação não poderá ser desfeita.</p></div><div className="modal-product"><img src={dialog.offer?.image} alt="" /><span><strong>{dialog.offer?.title || 'Oferta selecionada'}</strong><small>{dialog.offer?.store}</small></span></div><div className="modal-actions"><button className="button subtle" type="button" onClick={() => setDialog(null)}>Manter oferta</button><button className="button danger-button" type="button" onClick={confirmRemoveOffer}>Excluir oferta</button></div></div>}</section></div>}</div>;
}

function InboxPanel({ messages = [], inboxConfig = {}, onMarkRead, onReply, onSetup }) {
  const sortedMessages = [...messages].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const [selectedId, setSelectedId] = useState(sortedMessages[0]?.id || '');
  const [replyText, setReplyText] = useState('');
  const [replyError, setReplyError] = useState('');
  const [inboundDomain, setInboundDomain] = useState(inboxConfig.inboxInboundDomain || 'reply.jhonatafaraujo.com.br');
  const [setupBusy, setSetupBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const selected = sortedMessages.find((item) => item.id === selectedId) || sortedMessages[0] || null;
  const unreadCount = sortedMessages.filter((item) => item.status === 'unread').length;

  useEffect(() => {
    if (!selectedId || !sortedMessages.some((item) => item.id === selectedId)) {
      setSelectedId(sortedMessages[0]?.id || '');
    }
  }, [selectedId, messages]);

  useEffect(() => {
    setReplyText('');
    setReplyError('');
  }, [selectedId]);

  useEffect(() => {
    if (inboxConfig.inboxInboundDomain) setInboundDomain(inboxConfig.inboxInboundDomain);
  }, [inboxConfig.inboxInboundDomain]);

  function selectMessage(item) {
    setSelectedId(item.id);
    if (item.status === 'unread') onMarkRead(item.id, 'read');
  }

  async function submitReply(event) {
    event.preventDefault();
    if (!selected || !replyText.trim() || sending) return;

    setSending(true);
    setReplyError('');
    try {
      await onReply(selected.id, replyText.trim());
      setReplyText('');
    } catch (error) {
      setReplyError(error.message || 'Não foi possível enviar a resposta.');
    } finally {
      setSending(false);
    }
  }

  async function submitInboundSetup(event) {
    event.preventDefault();
    if (!inboundDomain.trim() || setupBusy) return;
    setSetupBusy(true);
    try {
      await onSetup(inboundDomain.trim());
    } catch {
      // O painel principal exibe o erro retornado pela API.
    } finally {
      setSetupBusy(false);
    }
  }

  return <div className="inbox-page">
    <section className="panel inbox-setup-panel">
      <div className="inbox-setup-copy"><span className="section-step">RESPOSTAS AUTOMÁTICAS</span><h2>{inboxConfig.inboxInboundEnabled ? 'Respostas por e-mail ativas' : 'Receba respostas nesta caixa'}</h2><p>{inboxConfig.inboxInboundEnabled ? `As respostas serão direcionadas para a conversa pelo subdomínio ${inboxConfig.inboxInboundDomain}.` : 'Para transformar o painel em uma caixa de entrada completa, use um subdomínio separado para receber as respostas.'}</p></div>
      <form className="inbox-setup-form" onSubmit={submitInboundSetup}><label>Subdomínio de recebimento<input required type="text" value={inboundDomain} onChange={(event) => setInboundDomain(event.target.value)} placeholder="reply.jhonatafaraujo.com.br" /></label><button className="button primary" type="submit" disabled={setupBusy}>{setupBusy ? 'Ativando…' : inboxConfig.inboxInboundEnabled ? 'Atualizar configuração' : 'Ativar recebimento'}</button></form>
      <div className="inbox-mx-hint"><strong>Antes ou depois de ativar, adicione no Registro.br:</strong><span><code>MX</code> prioridade <b>10</b> → <code>inbound1.sendinblue.com.</code></span><span><code>MX</code> prioridade <b>20</b> → <code>inbound2.sendinblue.com.</code></span><small>Use o host do subdomínio, por exemplo <code>reply</code>. A propagação pode levar algumas horas.</small></div>
    </section>
    <div className="inbox-layout">
    <section className="panel inbox-list-panel">
      <div className="panel-heading inbox-heading">
        <div><span className="section-step">ATENDIMENTO</span><h2>Mensagens recebidas</h2><p>{sortedMessages.length} mensagem(ns) · {unreadCount} não lida(s)</p></div>
        <span className="inbox-count">{unreadCount}</span>
      </div>
      {sortedMessages.length ? <div className="inbox-list">{sortedMessages.map((item) => <button type="button" className={`inbox-list-item ${selected?.id === item.id ? 'active' : ''} ${item.status === 'unread' ? 'unread' : ''}`} key={item.id} onClick={() => selectMessage(item)}><span className="inbox-avatar">{String(item.name || '?').slice(0, 1).toUpperCase()}</span><span className="inbox-list-copy"><strong>{item.name || 'Visitante'}</strong><small>{item.subject || item.email}</small><span>{String(item.message || '').replace(/\s+/g, ' ').slice(0, 90)}{String(item.message || '').length > 90 ? '…' : ''}</span></span><time>{item.createdAt ? new Date(item.createdAt).toLocaleDateString('pt-BR') : ''}</time></button>)}</div> : <div className="empty inbox-empty"><strong>Nenhuma mensagem ainda</strong><p>As mensagens enviadas pelo formulário da página de contato aparecerão aqui.</p></div>}
    </section>
    <section className="panel inbox-detail-panel">
      {selected ? <>
        <div className="inbox-detail-head"><div><span className="section-step">MENSAGEM</span><h2>{selected.name || 'Visitante'}</h2><a href={`mailto:${selected.email}`}>{selected.email}</a></div><div className="inbox-detail-actions"><span className={`inbox-status ${selected.status}`}>{selected.status === 'unread' ? 'Não lida' : selected.status === 'replied' ? 'Respondida' : 'Lida'}</span><button className="text-button" type="button" onClick={() => onMarkRead(selected.id, selected.status === 'unread' ? 'read' : 'unread')}>{selected.status === 'unread' ? 'Marcar como lida' : 'Marcar como não lida'}</button></div></div>
        <div className="inbox-meta"><span>Recebida em {selected.createdAt ? new Date(selected.createdAt).toLocaleString('pt-BR') : '—'}</span>{selected.subject && <span>Assunto: {selected.subject}</span>}{selected.deliveryStatus === 'failed' && <span className="inbox-delivery-error">A notificação por e-mail falhou, mas a mensagem foi salva aqui.</span>}</div>
        <div className="inbox-message-body">{selected.message}</div>
        {(selected.replies || []).length > 0 && <div className="inbox-replies"><h3>Histórico da conversa</h3>{selected.replies.map((reply) => <article className={reply.direction === 'inbound' ? 'inbound' : 'outbound'} key={reply.id}><div><strong>{reply.direction === 'inbound' ? (reply.name || selected.name || 'Visitante') : 'Você'}</strong><time>{reply.createdAt ? new Date(reply.createdAt).toLocaleString('pt-BR') : ''}</time></div><p>{reply.message}</p></article>)}</div>}
        <form className="inbox-reply-form" onSubmit={submitReply}><label>Responder para {selected.name || 'visitante'}<textarea required minLength={1} maxLength={4000} rows={6} value={replyText} onChange={(event) => setReplyText(event.target.value)} placeholder="Escreva sua resposta…" /></label>{replyError && <p className="inbox-reply-error" role="alert">{replyError}</p>}<div className="inbox-reply-footer"><small>A resposta será enviada pelo remetente configurado na Brevo.</small><button className="button primary" type="submit" disabled={sending || !replyText.trim()}>{sending ? 'Enviando…' : 'Enviar resposta'}</button></div></form>
      </> : <div className="empty inbox-empty"><strong>Selecione uma mensagem</strong><p>Escolha uma mensagem na lista para ler e responder.</p></div>}
    </section>
    </div>
  </div>;
}

function AnalyticsDashboard({ analytics = {}, config = {}, secrets = {}, secretForm = {}, setSecretForm, searchConsole, onConnect, onRefreshSearchConsole, setConfigField }) {
  const [period, setPeriod] = useState(30);
  const today = analytics.today || {};
  const periodKey = period === 90 ? 'last90Days' : period === 30 ? 'last30Days' : 'last14Days';
  const days = Array.isArray(analytics[periodKey]) ? analytics[periodKey] : [];
  const maxPageViews = Math.max(1, ...days.map((day) => Number(day.pageViews || 0)));
  const clickTypes = { offer: 'Ofertas', coupon: 'Cupons', whatsapp: 'WhatsApp', group: 'Grupos', favorite: 'Favoritos' };
  function exportAnalytics() {
    const rows = [['data', 'visualizacoes', 'sessoes', 'visitantes_unicos', 'cliques'], ...days.map((day) => [day.date, day.pageViews, day.sessions, day.uniqueVisitors, day.clicks])];
    const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    link.download = `promoshop-acessos-${period}-dias.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return <div className="analytics-layout">
    <div className="stats analytics-stats">
      <div><span><i>◌</i>Visitantes únicos</span><strong>{Number(analytics.totalVisitors || 0).toLocaleString('pt-BR')}</strong><small>Navegadores que aceitaram a medição</small></div>
      <div><span><i>⌁</i>Acessos hoje</span><strong>{Number(today.pageViews || 0).toLocaleString('pt-BR')}</strong><small>Visualizações de páginas</small></div>
      <div><span><i>↗</i>Visitantes hoje</span><strong>{Number(today.uniqueVisitors || 0).toLocaleString('pt-BR')}</strong><small>Navegadores únicos no dia</small></div>
      <div><span><i>◷</i>Sessões</span><strong>{Number(analytics.totalSessions || 0).toLocaleString('pt-BR')}</strong><small>Períodos de até 30 minutos</small></div>
      <div><span><i>◎</i>Cliques medidos</span><strong>{Number(analytics.totalClicks || 0).toLocaleString('pt-BR')}</strong><small>Interações autorizadas</small></div>
    </div>

    <section className="panel search-console-panel"><div className="panel-heading"><div><span className="section-step">GOOGLE SEARCH CONSOLE</span><h2>Desempenho na pesquisa Google</h2><p>{secrets.googleSearchConsoleConnected ? 'A conexão está pronta. Atualize para buscar os últimos dados disponíveis.' : 'Conecte a propriedade verificada para acompanhar cliques, impressões e termos pesquisados.'}</p></div><div className="review-actions">{secrets.googleSearchConsoleConnected && <button className="button subtle" type="button" onClick={onRefreshSearchConsole}>Atualizar dados</button>}<button className="button primary" type="button" onClick={onConnect}>{secrets.googleSearchConsoleConnected ? 'Reconectar Google' : 'Conectar Google'}</button></div></div><div className="settings-grid"><label>Propriedade<input value={config.searchConsoleSiteUrl || ''} onChange={(event) => setConfigField('searchConsoleSiteUrl', event.target.value)} placeholder="sc-domain:jhonatafaraujo.com.br" /></label><label>URL de retorno<input value={config.searchConsoleRedirectUri || ''} onChange={(event) => setConfigField('searchConsoleRedirectUri', event.target.value)} /></label><label>ID do cliente OAuth<input value={secretForm.googleSearchConsoleClientId || ''} onChange={(event) => setSecretForm({ ...secretForm, googleSearchConsoleClientId: event.target.value.trim() })} placeholder={secrets.googleSearchConsoleClientIdConfigured ? 'ID configurado — deixe vazio para manter' : '...apps.googleusercontent.com'} /></label><label>Chave secreta OAuth<input type="password" value={secretForm.googleSearchConsoleClientSecret || ''} onChange={(event) => setSecretForm({ ...secretForm, googleSearchConsoleClientSecret: event.target.value })} placeholder={secrets.googleSearchConsoleClientSecretConfigured ? 'Chave configurada — deixe vazio para manter' : 'Cole a chave secreta'} /></label></div>{searchConsole && <><div className="stats search-console-stats"><div><span>Cliques no Google</span><strong>{Number(searchConsole.totals?.clicks || 0).toLocaleString('pt-BR')}</strong></div><div><span>Impressões</span><strong>{Number(searchConsole.totals?.impressions || 0).toLocaleString('pt-BR')}</strong></div><div><span>CTR</span><strong>{(Number(searchConsole.totals?.ctr || 0) * 100).toFixed(1)}%</strong></div><div><span>Posição média</span><strong>{Number(searchConsole.totals?.position || 0).toFixed(1)}</strong></div></div><div className="analytics-detail-grid"><div className="analytics-ranking-list">{searchConsole.queries?.map((row) => <div key={row.keys?.[0]}><span>{row.keys?.[0]}</span><strong>{Number(row.clicks || 0)} clique(s)</strong></div>)}</div><div className="analytics-ranking-list">{searchConsole.pages?.map((row) => <div key={row.keys?.[0]}><span>{String(row.keys?.[0] || '').replace(/^https?:\/\/[^/]+/, '') || '/'}</span><strong>{Number(row.clicks || 0)} clique(s)</strong></div>)}</div></div></>}</section>

    <section className="panel analytics-panel">
      <div className="panel-heading"><div><span className="section-step">ALCANCE DO SITE</span><h2>Visualizações nos últimos {period} dias</h2><p>Uma pessoa que retorna depois de 30 minutos inicia uma nova sessão.</p></div><div className="analytics-toolbar"><select value={period} onChange={(event) => setPeriod(Number(event.target.value))} aria-label="Período"><option value="14">14 dias</option><option value="30">30 dias</option><option value="90">90 dias</option></select><button className="button subtle" type="button" onClick={exportAnalytics}>Exportar CSV</button></div></div>
      {days.length ? <div className="analytics-chart" aria-label="Gráfico de visualizações por dia">{days.map((day) => {
        const height = Math.max(8, Math.round((Number(day.pageViews || 0) / maxPageViews) * 100));
        return <div className="analytics-bar-group" key={day.date} title={`${day.date}: ${day.pageViews || 0} visualizações e ${day.uniqueVisitors || 0} visitantes`}><strong>{Number(day.pageViews || 0).toLocaleString('pt-BR')}</strong><div className="analytics-bar" style={{ height: `${height}%` }}></div><small>{String(day.date || '').slice(8, 10)}/{String(day.date || '').slice(5, 7)}</small></div>;
      })}</div> : <div className="empty"><strong>Ainda não há acessos registrados</strong><p>As métricas aparecerão assim que alguém visitar o site público.</p></div>}
    </section>

    <div className="analytics-detail-grid">
      <section className="panel analytics-ranking"><div className="panel-heading"><div><span className="section-step">INTERAÇÕES</span><h2>Cliques por tipo</h2><p>Somente visitantes que aceitaram a medição.</p></div></div><div className="analytics-ranking-list">{Object.entries(clickTypes).map(([key, label]) => <div key={key}><span>{label}</span><strong>{Number(analytics.clicksByType?.[key] || 0).toLocaleString('pt-BR')}</strong></div>)}</div></section>
      <section className="panel analytics-ranking"><div className="panel-heading"><div><span className="section-step">LOJAS</span><h2>Cliques por loja</h2><p>Ajuda a entender onde há mais interesse.</p></div></div><div className="analytics-ranking-list">{Object.entries(analytics.clicksByStore || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8).map(([store, count]) => <div key={store}><span>{store}</span><strong>{Number(count).toLocaleString('pt-BR')}</strong></div>)}{!Object.keys(analytics.clicksByStore || {}).length && <small>Ainda não há cliques por loja.</small>}</div></section>
    </div>

    <section className="panel analytics-ranking"><div className="panel-heading"><div><span className="section-step">CONTEÚDOS</span><h2>Ofertas, cupons e destinos mais acessados</h2><p>O painel guarda o nome resumido e os totais, não o endereço completo do link.</p></div></div><div className="analytics-ranking-list">{(analytics.topTargets || []).map((target) => <div key={`${target.type}-${target.targetId}`}><span><b>{clickTypes[target.type] || target.type}</b> · {target.label || 'Destino sem nome'}{target.store ? ` · ${target.store}` : ''}</span><strong>{Number(target.count || 0).toLocaleString('pt-BR')}</strong></div>)}{!(analytics.topTargets || []).length && <small>Os conteúdos mais acessados aparecerão aqui.</small>}</div></section>

    <section className="panel analytics-note"><div className="analytics-note-icon">◎</div><div><h2>Como a contagem funciona</h2><p>A contagem inclui somente quem aceitou a medição de acessos. O site cria um identificador anônimo no navegador para reconhecer retornos sem coletar nome, e-mail, endereço IP ou impressão digital do dispositivo. Se a pessoa rejeitar, limpar os dados do navegador ou trocar de dispositivo, ela não será reconhecida pelo identificador anterior.</p><small>O painel mostra visitantes únicos por navegador entre as pessoas que autorizaram a medição. Quem rejeita continua usando o site normalmente e não entra nessas métricas.</small></div></section>
  </div>;
}

function QueueTable({ queue, onRemove, onForce, onRetry }) {
  if (!queue.length) return <div className="empty"><strong>A fila está vazia</strong><p>Envie uma oferta pelo painel.</p></div>;
  return <div className="queue-table">{queue.map((item) => <div key={item.id}><span><strong>{item.offerTitle}</strong>
    <small>
      {item.store}

      {Array.isArray(item.targetAudienceCodes) &&
        item.targetAudienceCodes.length > 0
        ? ` · ${item.targetAudienceCodes.join(', ')}`
        : ''}

      {item.force && item.status === 'pending'
        ? ' · envio imediato'
        : ''}

      {item.error
        ? ` · ${item.error}`
        : ''}
    </small>
  </span><span className={`status ${item.status}`}>{item.status === 'pending' ? (item.force ? 'Prioridade' : 'Aguardando') : item.status === 'sent' ? 'Enviada' : item.status === 'failed' ? 'Falhou' : item.status}</span><time>{new Date(item.createdAt).toLocaleString('pt-BR')}</time><div className="queue-actions">{onRetry && item.status === 'failed' && <button className="queue-force" onClick={() => onRetry(item.id)}>Tentar novamente</button>}{onForce && item.status === 'pending' && !item.force && <button className="queue-force" onClick={() => onForce(item.id)}>Publicar agora</button>}{onRemove && item.status !== 'sent' && <button className="queue-remove" onClick={() => onRemove(item.id)}>Remover</button>}</div></div>)}</div>;
}

const isAdmin = window.location.pathname.startsWith('/admin');
const normalizedPublicPath = window.location.pathname.replace(/\/+$/, '') || '/';
const isInfoPage = Object.prototype.hasOwnProperty.call(publicInfoPages, normalizedPublicPath);
const productSlug = normalizedPublicPath.match(/^\/oferta\/([^/]+)$/)?.[1] || '';
createRoot(document.getElementById('root')).render(<React.StrictMode>{isAdmin ? <AdminApp /> : isInfoPage ? <InfoPage page={normalizedPublicPath} /> : productSlug ? <ProductDetail slug={productSlug} /> : <PublicSite />}</React.StrictMode>);
