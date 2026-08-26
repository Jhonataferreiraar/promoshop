import { addLog, createId, updateStore } from './store.js';
import { readSecrets } from './secrets.js';
import crypto from 'node:crypto';
import { getMercadoLivreAccessToken } from './mercadolivre.js';
import { getAudienceCodesForOffer } from './audienceRouting.js';
import {
  generateMercadoLivreAffiliateLinks,
  normalizeMercadoLivreAffiliateUrl
} from './mercadolivreAffiliate.js';
import { buildSearchQueryVariants } from './searchRelevance.js';
import { hasPendingSource } from './whatsappDedup.js';

function calculateDiscount(price, originalPrice) {
  if (!originalPrice || originalPrice <= price) return 0;
  return Math.round((1 - price / originalPrice) * 100);
}

function normalizeMercadoLivre(item) {
  const price = Number(item.price || 0);
  const originalPrice = Number(item.original_price || item.originalPrice || 0);
  return {
    id: `ml_${item.id}`,
    externalId: item.id,
    title: item.title,
    store: 'Mercado Livre',
    category: item.domain_id?.replace('MLB-', '').replaceAll('_', ' ') || 'Mercado Livre',
    price,
    originalPrice,
    image: item.thumbnail?.replace('http://', 'https://').replace('-I.', '-O.') || '',
    productUrl: item.permalink,
    affiliateUrl: item.permalink,
    freeShipping: Boolean(item.shipping?.free_shipping),
    featured: calculateDiscount(price, originalPrice) >= 30,
    status: 'pending-link',
    source: 'mercado-livre',
    score: calculateDiscount(price, originalPrice),
    createdAt: new Date().toISOString()
  };
}

function normalizeMercadoLivreCatalog(product) {
  const winner = product.buy_box_winner || {};
  const price = Number(winner.price || 0);
  const originalPrice = Number(winner.original_price || 0);
  const id = winner.item_id || product.id;
  const permalink = product.permalink || (product.id ? `https://www.mercadolivre.com.br/p/${product.id}` : '');
  const picture = product.pictures?.[0]?.secure_url || product.pictures?.[0]?.url || product.thumbnail || '';
  if (!id || !product.name || !price || !permalink) return null;
  return {
    id: `ml_${id}`,
    externalId: id,
    title: product.name,
    store: 'Mercado Livre',
    category: product.domain_id?.replace('MLB-', '').replaceAll('_', ' ') || 'Mercado Livre',
    price,
    originalPrice,
    image: String(picture).replace('http://', 'https://'),
    productUrl: permalink,
    affiliateUrl: permalink,
    freeShipping: Boolean(winner.shipping?.free_shipping),
    featured: calculateDiscount(price, originalPrice) >= 30,
    status: 'pending-link',
    source: 'mercado-livre',
    score: calculateDiscount(price, originalPrice),
    createdAt: new Date().toISOString()
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = {}; }
  if (!response.ok) {
    const reason = payload.message || payload.error_description || payload.error || raw.slice(0, 180);
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-correlation-id');
    throw new Error(`Fonte respondeu com status ${response.status}${reason ? `: ${reason}` : ''}${requestId ? ` (requisição ${requestId})` : ''}`);
  }
  return payload;
}

export async function collectMercadoLivre(config, secrets) {
  if (!config.enableMercadoLivre) return [];

  const token = await getMercadoLivreAccessToken();

  const headers = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  const categoryIds = Array.isArray(config.mercadoLivreCategories)
    ? config.mercadoLivreCategories.filter(Boolean)
    : [];

  const manualQueries = String(config.mercadoLivreQueries || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  /*
   * Cada categoria do painel é convertida em palavras-chave.
   *
   * O endpoint /products/search que estamos usando exige um
   * critério de pesquisa como keywords/q, portanto não usamos
   * mais category_id sozinho.
   */
  const categoryQueries = {
    MLB5672: [
      'acessórios automotivos',
      'peças automotivas',
      'acessórios para carro'
    ],

    MLB271599: [
      'agro',
      'ferramentas agrícolas',
      'irrigação'
    ],

    MLB1403: [
      'alimentos',
      'bebidas',
      'mercearia'
    ],

    MLB1071: [
      'pet shop',
      'ração cachorro',
      'ração gato'
    ],

    MLB1367: [
      'colecionáveis',
      'antiguidades'
    ],

    MLB1368: [
      'papelaria',
      'material escolar',
      'artesanato'
    ],

    MLB1384: [
      'bebê',
      'fralda bebê',
      'carrinho bebê'
    ],

    MLB1246: [
      'beleza',
      'perfume',
      'maquiagem'
    ],

    MLB1132: [
      'brinquedos',
      'boneca',
      'blocos de montar'
    ],

    MLB1430: [
      'roupas',
      'tênis',
      'bolsa'
    ],

    MLB1039: [
      'câmera',
      'câmera digital',
      'lente câmera'
    ],

    MLB1743: [
      'carro',
      'moto'
    ],

    MLB1574: [
      'casa',
      'decoração',
      'móveis'
    ],

    MLB1051: [
      'smartphone',
      'celular',
      'smartwatch'
    ],

    MLB1500: [
      'construção',
      'material construção',
      'torneira'
    ],

    MLB5726: [
      'air fryer',
      'microondas',
      'cafeteira'
    ],

    MLB1000: [
      'fone bluetooth',
      'caixa de som',
      'televisão'
    ],

    MLB1276: [
      'academia',
      'fitness',
      'bicicleta'
    ],

    MLB263532: [
      'furadeira',
      'parafusadeira',
      'ferramentas'
    ],

    MLB12404: [
      'festa',
      'decoração festa',
      'fantasia'
    ],

    MLB1144: [
      'videogame',
      'playstation',
      'xbox'
    ],

    MLB1499: [
      'equipamento comercial',
      'equipamento industrial',
      'embalagem'
    ],

    MLB1648: [
      'notebook',
      'computador',
      'monitor'
    ],

    MLB1182: [
      'violão',
      'guitarra',
      'teclado musical'
    ],

    MLB3937: [
      'relógio',
      'joias',
      'colar'
    ],

    MLB1196: [
      'livros',
      'mangá'
    ],

    MLB1168: [
      'filmes',
      'vinil',
      'cd música'
    ],

    MLB264586: [
      'massageador',
      'ortopedia',
      'cuidados saúde'
    ]
  };

  const collected = [];

  /*
   * =====================================================
   * PROCESSA OS PRODUTOS ENCONTRADOS
   * =====================================================
   */

  async function processProducts(products) {
    const limitedProducts = products.slice(0, 10);

    const detailResults = await Promise.allSettled(
      limitedProducts.map(async (product) => {
        const productId = encodeURIComponent(product.id);

        const detail =
          product.buy_box_winner && product.pictures?.length
            ? product
            : await fetchJson(
              `https://api.mercadolibre.com/products/${productId}`,
              { headers }
            );

        if (detail.buy_box_winner) {
          return detail;
        }

        let listings;

        try {
          listings = await fetchJson(
            `https://api.mercadolibre.com/products/${productId}/items?limit=5`,
            { headers }
          );
        } catch (error) {
          if (/status 404|no winners found/i.test(error.message)) {
            return detail;
          }

          throw error;
        }

        const availableListings = (listings.results || [])
          .filter((item) => Number(item.price) > 0);

        const selectedListing = availableListings[0] || null;

        return selectedListing
          ? {
            ...detail,
            buy_box_winner: selectedListing
          }
          : detail;
      })
    );

    return detailResults
      .filter((result) => result.status === 'fulfilled')
      .map((result) => normalizeMercadoLivreCatalog(result.value))
      .filter(Boolean);
  }

  /*
   * =====================================================
   * FUNÇÃO DE BUSCA
   * =====================================================
   */

  async function searchProducts(query, origin = 'busca') {
    try {
      const searchUrl =
        `https://api.mercadolibre.com/products/search` +
        `?status=active` +
        `&site_id=MLB` +
        `&q=${encodeURIComponent(query)}` +
        `&limit=10`;

      const search = await fetchJson(searchUrl, { headers });

      const products = search.results || [];

      if (!products.length) {
        await addLog(
          `Mercado Livre: ${origin} "${query}" não retornou ofertas.`,
          'info'
        );

        return [];
      }

      const normalized = await processProducts(products);

      await addLog(
        `Mercado Livre: ${origin} "${query}" retornou ${normalized.length} ofertas.`,
        'info'
      );

      return normalized;
    } catch (error) {
      await addLog(
        `Mercado Livre: erro em ${origin} "${query}": ${error.message}`,
        'error'
      );

      return [];
    }
  }

  /*
   * =====================================================
   * 1. BUSCA PELAS CATEGORIAS SELECIONADAS
   * =====================================================
   */

  for (const categoryId of categoryIds) {
    const queriesForCategory = categoryQueries[categoryId] || [];

    if (!queriesForCategory.length) {
      await addLog(
        `Mercado Livre: categoria ${categoryId} não possui palavras-chave configuradas.`,
        'info'
      );

      continue;
    }

    for (const query of queriesForCategory) {
      const offers = await searchProducts(
        query,
        `categoria ${categoryId}`
      );

      collected.push(...offers);
    }
  }

  /*
   * =====================================================
   * 2. BUSCAS MANUAIS DO PAINEL
   * =====================================================
   */

  for (const query of manualQueries) {
    const offers = await searchProducts(
      query,
      'busca adicional'
    );

    collected.push(...offers);
  }

  /*
   * =====================================================
   * 3. REMOVE PRODUTOS DUPLICADOS
   * =====================================================
   */

  const uniqueOffers = [
    ...new Map(
      collected.map((offer) => [
        offer.id,
        offer
      ])
    ).values()
  ];

  await addLog(
    `Mercado Livre: ${uniqueOffers.length} ofertas únicas encontradas antes do filtro de desconto.`,
    'info'
  );

  /*
   * =====================================================
   * 4. TENTA GERAR LINKS DE AFILIADO AUTOMATICAMENTE
   * =====================================================
   */

  const linksByProduct = await generateMercadoLivreAffiliateLinks(
    uniqueOffers.map((offer) => offer.productUrl),
    {
      tag: config.mercadoLivreAffiliateTag || 'promoshop'
    }
  );

  for (const offer of uniqueOffers) {
    const normalizedUrl = normalizeMercadoLivreAffiliateUrl(
      offer.productUrl
    );

    const affiliateUrl = linksByProduct.get(normalizedUrl);

    if (affiliateUrl) {
      offer.affiliateUrl = affiliateUrl;
      offer.status = 'active';
    }
  }

  const automaticLinks = uniqueOffers.filter(
    (offer) => offer.status === 'active'
  ).length;

  await addLog(
    `Mercado Livre: ${automaticLinks} de ${uniqueOffers.length} ofertas receberam link de afiliado automaticamente.`,
    automaticLinks ? 'success' : 'info'
  );

  return uniqueOffers;
}

async function hydrateMercadoLivreCatalogProducts(products, headers) {
  const detailResults = await Promise.allSettled(
    products.map(async (product) => {
      const productId = encodeURIComponent(product.id);

      const detail =
        product.buy_box_winner && product.pictures?.length
          ? product
          : await fetchJson(
            `https://api.mercadolibre.com/products/${productId}`,
            { headers }
          );

      if (detail.buy_box_winner) {
        return detail;
      }

      try {
        const listings = await fetchJson(
          `https://api.mercadolibre.com/products/${productId}/items?limit=5`,
          { headers }
        );

        const selectedListing = (listings.results || [])
          .find((item) => Number(item.price) > 0);

        return selectedListing
          ? {
            ...detail,
            buy_box_winner: selectedListing
          }
          : detail;
      } catch (error) {
        if (/status 404|no winners found/i.test(error.message)) {
          return detail;
        }

        throw error;
      }
    })
  );

  return detailResults
    .filter((result) => result.status === 'fulfilled')
    .map((result) => normalizeMercadoLivreCatalog(result.value))
    .filter(Boolean)
    .map((offer) => ({
      ...offer,
      searchSource: 'manual-search'
    }));
}

async function searchMercadoLivreCategoryHighlights(cleanQuery, headers, limit) {
  const discovered = await fetchJson(
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${encodeURIComponent(cleanQuery)}`,
    { headers }
  );
  const categories = (Array.isArray(discovered) ? discovered : [])
    .map((item) => item.category_id)
    .filter(Boolean)
    .slice(0, 2);
  if (!categories.length) return [];

  const highlightResults = await Promise.allSettled(categories.map((categoryId) => fetchJson(
    `https://api.mercadolibre.com/highlights/MLB/category/${encodeURIComponent(categoryId)}`,
    { headers }
  )));
  const entries = highlightResults
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value.content || [])
    .slice(0, Math.max(20, limit));

  const details = await Promise.allSettled(entries.map(async (entry) => {
    if (entry.type === 'ITEM') {
      const item = await fetchJson(
        `https://api.mercadolibre.com/items/${encodeURIComponent(entry.id)}`,
        { headers }
      );
      return normalizeMercadoLivre(item);
    }
    if (entry.type === 'PRODUCT') {
      const product = await fetchJson(
        `https://api.mercadolibre.com/products/${encodeURIComponent(entry.id)}`,
        { headers }
      );
      const [offer] = await hydrateMercadoLivreCatalogProducts([product], headers);
      return offer || null;
    }
    return null;
  }));

  return details
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => ({
      ...result.value,
      searchSource: 'category-best-sellers'
    }));
}

export async function searchMercadoLivreProducts(query, limit = 10) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('Informe o produto que deseja buscar.');

  const token = await getMercadoLivreAccessToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);
  let primaryError = null;
  let catalogOffers = [];

  try {
    const search = await fetchJson(
      `https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(cleanQuery)}&limit=${safeLimit}`,
      { headers }
    );
    catalogOffers = await hydrateMercadoLivreCatalogProducts(search.results || [], headers);
  } catch (error) {
    primaryError = error;
  }

  let highlightOffers = [];
  if (token && catalogOffers.length < safeLimit) {
    try {
      highlightOffers = await searchMercadoLivreCategoryHighlights(cleanQuery, headers, safeLimit);
    } catch (error) {
      if (!catalogOffers.length && !primaryError) primaryError = error;
    }
  }

  const seen = new Set();
  const combined = [...catalogOffers, ...highlightOffers].filter((offer) => {
    const fingerprint = String(offer.externalId || offer.productUrl || '');
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
  if (!combined.length && primaryError) throw primaryError;
  return combined;
}

async function shopeeGraphQL(appId, appSecret, query) {
  const body = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha256').update(`${appId}${timestamp}${body}${appSecret}`).digest('hex');
  const response = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`
    },
    body
  });
  if (!response.ok) throw new Error(`Open API respondeu com status ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) {
    const detail = payload.errors[0]?.extensions?.message || payload.errors[0]?.message || 'Erro desconhecido da Open API';
    throw new Error(detail);
  }
  return payload.data?.productOfferV2?.nodes || [];
}

function escapeGraphQL(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

export async function collectShopee(config, secrets) {
  if (!config.enableShopee) return [];
  const appId = secrets.shopeeAppId || process.env.SHOPEE_APP_ID;
  const appSecret = secrets.shopeeAppSecret || process.env.SHOPEE_APP_SECRET;
  if (!appId || !appSecret) throw new Error('Configure o App ID e o App Secret da Open API no painel.');
  const keywords = String(config.shopeeQueries || '').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 8);
  const items = [];
  for (const keyword of keywords) {
    const query = `{ productOfferV2(keyword: "${escapeGraphQL(keyword)}", page: 1, limit: 20) { nodes { itemId productName productLink offerLink imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate shopId shopName periodEndTime } pageInfo { page limit hasNextPage } } }`;
    items.push(...await shopeeGraphQL(appId, appSecret, query));
  }
  return items.map((item) => ({
    id: item.itemId ? `shopee_${item.itemId}` : createId('shopee'),
    externalId: item.itemId || null,
    title: item.productName,
    store: 'Shopee',
    category: item.shopName || 'Shopee',
    price: Number(item.priceMin || item.priceMax || 0),
    originalPrice: Number(item.priceDiscountRate || 0) > 0 ? Number(item.priceMin || item.priceMax || 0) / (1 - Number(item.priceDiscountRate) / 100) : Number(item.priceMax || 0),
    image: item.imageUrl || '',
    productUrl: item.productLink || item.offerLink,
    affiliateUrl: item.offerLink,
    freeShipping: false,
    featured: Number(item.priceDiscountRate || 0) >= 30,
    status: item.offerLink ? 'active' : 'pending-link',
    source: 'shopee-open-api',
    score: Number(item.priceDiscountRate || 0),
    commissionRate: Number(item.commissionRate || 0),
    sales: Number(item.sales || 0),
    createdAt: new Date().toISOString()
  }));
}

export async function searchShopeeProducts(query, secrets, limit = 10) {
  const cleanQuery = String(query || '').trim();

  if (!cleanQuery) {
    throw new Error('Informe o produto que deseja buscar.');
  }

  const appId =
    secrets?.shopeeAppId ||
    process.env.SHOPEE_APP_ID;

  const appSecret =
    secrets?.shopeeAppSecret ||
    process.env.SHOPEE_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      'Configure o App ID e o App Secret da Shopee antes de pesquisar.'
    );
  }

  const candidateLimit = Math.min(Math.max(Number(limit) || 40, 20), 200);
  const variants = buildSearchQueryVariants(cleanQuery, 3);
  const pageBudget = Math.min(10, Math.max(4, Math.ceil(candidateLimit / 20)));
  const searches = [];
  let popularPage = 1;
  let relevanceCursor = 0;
  while (searches.length < pageBudget) {
    if (searches.length % 3 === 0) {
      searches.push({
        variant: variants[0] || cleanQuery,
        page: popularPage,
        sortType: 2
      });
      popularPage += 1;
      continue;
    }
    const variantIndex = relevanceCursor % variants.length;
    searches.push({
      variant: variants[variantIndex],
      page: Math.floor(relevanceCursor / variants.length) + 1,
      sortType: 1
    });
    relevanceCursor += 1;
  }

  const responses = await Promise.allSettled(searches.map(({ variant, page, sortType }, searchIndex) => {
    const graphqlQuery =
      `{ productOfferV2(` +
      `keyword: "${escapeGraphQL(variant)}", ` +
      `listType: 0, ` +
      `sortType: ${sortType}, ` +
      `page: ${page}, ` +
      `limit: 20` +
      `) { ` +
      `nodes { ` +
      `itemId productName productLink offerLink imageUrl ` +
      `priceMin priceMax priceDiscountRate sales ratingStar ` +
      `commissionRate shopId shopName periodEndTime ` +
      `} ` +
      `pageInfo { page limit hasNextPage } ` +
      `} }`;
    return shopeeGraphQL(appId, appSecret, graphqlQuery).then((nodes) => nodes.map((item, itemIndex) => ({
      ...item,
      sourceRank: searchIndex * 20 + itemIndex + 1,
      searchOrder: sortType === 2 ? 'popular' : 'relevance'
    })));
  }));

  const successful = responses.filter((response) => response.status === 'fulfilled');
  if (!successful.length) {
    const firstFailure = responses.find((response) => response.status === 'rejected');
    throw firstFailure?.reason || new Error('A Shopee não respondeu à pesquisa.');
  }

  const seen = new Set();
  const items = successful.flatMap((response) => response.value).filter((item) => {
    const fingerprint = String(item.itemId || item.offerLink || item.productLink || '');
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }).slice(0, candidateLimit);

  return items.map((item) => {
    const price = Number(
      item.priceMin ||
      item.priceMax ||
      0
    );

    const discountRate = Number(
      item.priceDiscountRate ||
      0
    );

    const originalPrice =
      discountRate > 0 && price > 0
        ? price / (1 - discountRate / 100)
        : Number(item.priceMax || price);

    return {
      id: item.itemId
        ? `shopee_${item.itemId}`
        : createId('shopee-search'),

      externalId: item.itemId || null,
      title: item.productName,
      store: 'Shopee',
      category: item.shopName || 'Shopee',
      price,
      originalPrice,
      image: item.imageUrl || '',
      productUrl: item.productLink || item.offerLink,
      affiliateUrl: item.offerLink || '',
      freeShipping: false,
      featured: discountRate >= 30,
      status: item.offerLink ? 'active' : 'pending-link',
      source: 'shopee-open-api',
      searchSource: 'manual-search',
      score: discountRate,
      rating: Number(item.ratingStar || 0),
      commissionRate: Number(item.commissionRate || 0),
      sales: Number(item.sales || 0),
      sourceRank: Number(item.sourceRank || 0),
      searchOrder: item.searchOrder || 'relevance',
      createdAt: new Date().toISOString()
    };
  });
}

function chinaTimestamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

function parsePercent(value) {
  const parsed = Number.parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractAliProducts(value, found = []) {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return extractAliProducts(JSON.parse(value), found); } catch { return found; }
  }
  if (Array.isArray(value)) {
    for (const item of value) extractAliProducts(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (value.product_id && value.product_title) {
    found.push(value);
    return found;
  }
  for (const item of Object.values(value)) extractAliProducts(item, found);
  return found;
}

function extractAliPromoNames(value, found = []) {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return extractAliPromoNames(JSON.parse(value), found); } catch { return found; }
  }
  if (Array.isArray(value)) {
    for (const item of value) extractAliPromoNames(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (typeof value.promo_name === 'string' && value.promo_name.trim()) found.push(value.promo_name.trim());
  for (const item of Object.values(value)) extractAliPromoNames(item, found);
  return found;
}

function extractAliPromotionLinks(value, found = []) {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return extractAliPromotionLinks(JSON.parse(value), found); } catch { return found; }
  }
  if (Array.isArray(value)) {
    for (const item of value) extractAliPromotionLinks(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (typeof value.promotion_link === 'string' && value.promotion_link.trim()) {
    found.push({ sourceValue: String(value.source_value || '').trim(), promotionLink: value.promotion_link.trim() });
    return found;
  }
  for (const item of Object.values(value)) extractAliPromotionLinks(item, found);
  return found;
}

async function aliexpressRequest(appKey, appSecret, method, businessParams) {
  const params = {
    method,
    app_key: appKey,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    format: 'json',
    v: '2.0',
    ...businessParams
  };
  const canonical = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  params.sign = crypto.createHmac('sha256', appSecret).update(canonical, 'utf8').digest('hex').toUpperCase();
  const response = await fetch('https://api-sg.aliexpress.com/sync', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params)
  });
  if (!response.ok) throw new Error(`Open API respondeu com status ${response.status}`);
  const payload = await response.json();
  if (payload.error_response) throw new Error(payload.error_response.sub_msg || payload.error_response.msg || 'Falha de autenticação');
  const responseKey = `${method.replaceAll('.', '_')}_response`;
  const responseBody = payload[responseKey]?.resp_result;
  if (!responseBody) throw new Error('A Open API não retornou uma resposta de produtos.');
  if (String(responseBody.resp_code || '200') !== '200') throw new Error(responseBody.resp_msg || `Código ${responseBody.resp_code}`);
  return typeof responseBody.result === 'string' ? JSON.parse(responseBody.result) : responseBody.result;
}

async function generateCompactAliexpressLinks(items, { appKey, appSecret, appSignature, trackingId }) {
  const linksByProductId = new Map();
  for (let offset = 0; offset < items.length; offset += 20) {
    const batch = items.slice(offset, offset + 20);
    const sources = batch.map((item) => `https://www.aliexpress.com/item/${item.product_id}.html`);
    const result = await aliexpressRequest(appKey, appSecret, 'aliexpress.affiliate.link.generate', {
      ...(appSignature ? { app_signature: appSignature } : {}),
      tracking_id: trackingId,
      promotion_link_type: '0',
      source_values: sources.join(',')
    });
    const generated = extractAliPromotionLinks(result);
    for (let index = 0; index < generated.length; index += 1) {
      const entry = generated[index];
      const productId = entry.sourceValue.match(/\/item\/(\d+)\.html/i)?.[1] || String(batch[index]?.product_id || '');
      if (productId && entry.promotionLink) linksByProductId.set(productId, entry.promotionLink);
    }
  }
  return linksByProductId;
}

export async function collectAliexpress(config, secrets) {
  if (!config.enableAliexpress) return [];
  const appKey = secrets.aliexpressAppKey || process.env.ALIEXPRESS_APP_KEY;
  const appSecret = secrets.aliexpressAppSecret || process.env.ALIEXPRESS_APP_SECRET;
  const appSignature = secrets.aliexpressAppSignature || process.env.ALIEXPRESS_APP_SIGNATURE;
  const trackingId = config.aliexpressTrackingId || process.env.ALIEXPRESS_TRACKING_ID;
  if (!appKey || !appSecret || !trackingId) throw new Error('Configure App Key, App Secret e Tracking ID no painel.');
  const products = [];
  const promoInfo = await aliexpressRequest(appKey, appSecret, 'aliexpress.affiliate.featuredpromo.get', {
    ...(appSignature ? { app_signature: appSignature } : {})
  });
  const promotions = [...new Set(extractAliPromoNames(promoInfo))].slice(0, 10);
  for (const promotionName of promotions) {
    const result = await aliexpressRequest(appKey, appSecret, 'aliexpress.affiliate.featuredpromo.products.get', {
      ...(appSignature ? { app_signature: appSignature } : {}),
      tracking_id: trackingId,
      promotion_name: promotionName,
      page_no: '1',
      page_size: '25',
      target_currency: 'BRL',
      target_language: 'PT',
      country: 'BR',
      sort: 'discountDesc',
      fields: 'product_id,product_title,product_main_image_url,target_sale_price,target_original_price,discount,promotion_link,product_detail_url,commission_rate,lastest_volume'
    });
    products.push(...extractAliProducts(result));
  }
  const uniqueProducts = [...new Map(products.map((item) => [String(item.product_id), item])).values()];
  const compactLinks = await generateCompactAliexpressLinks(uniqueProducts, { appKey, appSecret, appSignature, trackingId });
  return uniqueProducts.map((item) => {
    const price = Number(item.target_sale_price || item.sale_price || 0);
    const discount = parsePercent(item.discount);
    const originalPrice = Number(item.target_original_price || item.original_price || 0) || (discount > 0 ? price / (1 - discount / 100) : price);
    return {
      id: `aliexpress_${item.product_id}`,
      externalId: item.product_id,
      title: item.product_title,
      store: 'AliExpress',
      category: 'AliExpress',
      price,
      originalPrice,
      image: item.product_main_image_url || '',
      productUrl: item.product_detail_url || item.promotion_link,
      affiliateUrl: compactLinks.get(String(item.product_id)) || item.promotion_link,
      freeShipping: false,
      featured: discount >= 30,
      status: item.promotion_link ? 'active' : 'pending-link',
      source: 'aliexpress-open-api',
      score: discount,
      commissionRate: parsePercent(item.commission_rate),
      sales: Number(item.lastest_volume || 0),
      createdAt: new Date().toISOString()
    };
  });
}

export async function runCollection() {
  const snapshot = await (await import('./store.js')).readStore();
  const config = snapshot.config;
  const secrets = await readSecrets();
  let candidates = [];
  const errors = [];
  try { candidates.push(...await collectMercadoLivre(config, secrets)); }
  catch (error) { errors.push(`Mercado Livre: ${error.message}`); }
  try { candidates.push(...await collectShopee(config, secrets)); }
  catch (error) { errors.push(`Shopee: ${error.message}`); }
  try { candidates.push(...await collectAliexpress(config, secrets)); }
  catch (error) { errors.push(`AliExpress: ${error.message}`); }

  const minDiscount = Number(config.minDiscount || 0);
  // A mesma oferta pode aparecer em mais de uma busca. Mantemos a versão com
  // maior desconto e exigimos uma promoção real, evitando preço zerado,
  // desconto impossível ou anúncios repetidos na fila.
  const uniqueCandidates = new Map();
  for (const offer of candidates) {
    const urlKey = String(offer.affiliateUrl || offer.productUrl || '')
      .trim()
      .toLowerCase()
      .replace(/[?#].*$/, '');
    const titleKey = String(offer.title || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const key = urlKey || `${titleKey}|${Number(offer.price || 0).toFixed(2)}`;
    const previous = uniqueCandidates.get(key);
    if (!previous || Number(offer.score || 0) > Number(previous.score || 0)) {
      uniqueCandidates.set(key, offer);
    }
  }
  candidates = [...uniqueCandidates.values()].filter((offer) => {
    const calculatedDiscount = calculateDiscount(Number(offer.price), Number(offer.originalPrice));
    const reportedDiscount = Number(offer.score || 0);
    const discount = Math.max(calculatedDiscount, reportedDiscount);
    return Boolean(offer.title) && Number(offer.price) > 0 && discount >= minDiscount && discount <= 95;
  });
  let imported = 0;
  let refreshedLinks = 0;
  await updateStore((data) => {
    const refreshedAt = new Date().toISOString();
    const existing = new Map(data.offers.map((offer) => [offer.id, offer]));
    for (const offer of candidates.sort((a, b) => b.score - a.score)) {
      const savedOffer = existing.get(offer.id);
      if (savedOffer) {
        for (const key of ['title', 'store', 'category', 'price', 'originalPrice', 'image', 'freeShipping', 'featured']) {
          if (offer[key] !== undefined && offer[key] !== null && offer[key] !== '') savedOffer[key] = offer[key];
        }
        savedOffer.updatedAt = refreshedAt;
        /*
         * Recalcula os públicos da oferta existente.
         * Isso é importante caso você tenha alterado
         * palavras-chave ou criado novos públicos no painel.
         */
        savedOffer.targetAudienceCodes =
          getAudienceCodesForOffer(
            savedOffer,
            data.config.whatsappAudiences
          );

        if (
          offer.affiliateUrl &&
          savedOffer.affiliateUrl !== offer.affiliateUrl
        ) {
          savedOffer.affiliateUrl = offer.affiliateUrl;
          savedOffer.productUrl = offer.productUrl;

          for (
            const queueItem of data.queue.filter(
              (item) =>
                item.offerId === offer.id &&
                item.status === 'pending'
            )
          ) {
            const refreshedQueueItem =
              makeQueueItem(
                savedOffer,
                data.config
              );

            queueItem.message =
              refreshedQueueItem.message;

            queueItem.messageSource =
              refreshedQueueItem.messageSource;

            queueItem.offerSnapshot =
              refreshedQueueItem.offerSnapshot;

            queueItem.targetAudienceCodes =
              refreshedQueueItem.targetAudienceCodes;

            delete queueItem.aiStatus;
            delete queueItem.aiError;
            delete queueItem.aiRetryAt;
            delete queueItem.aiGeneratedAt;
            delete queueItem.aiGenerationVersion;
          }

          refreshedLinks += 1;
        }

        continue;
      }

      /*
       * Define os públicos antes de salvar
       * uma oferta nova.
       */
      offer.targetAudienceCodes =
        getAudienceCodesForOffer(
          offer,
          data.config.whatsappAudiences
        );

      offer.createdAt ||= refreshedAt;
      offer.updatedAt = refreshedAt;

      data.offers.unshift(offer);

      existing.set(
        offer.id,
        offer
      );

      imported += 1;
      if (data.config.autoQueue && offer.status === 'active') {
        const queueItem = makeQueueItem(offer, data.config);
        if (!hasPendingSource(data.queue, queueItem)) data.queue.push(queueItem);
      }
    }
    data.offers = data.offers.slice(0, 500);
    data.meta.lastCollectionAt = new Date().toISOString();
  });
  await addLog(`Coleta finalizada: ${imported} ofertas novas${refreshedLinks ? ` e ${refreshedLinks} links compactados` : ''}.`, imported || refreshedLinks ? 'success' : 'info');
  for (const error of errors) await addLog(error, 'error');
  return { imported, refreshedLinks, errors };
}

export function makeQueueItem(offer, config) {
  const discount = calculateDiscount(Number(offer.price), Number(offer.originalPrice));
  const values = {
    title: offer.title,
    price: Number(offer.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    originalPrice: Number(offer.originalPrice || offer.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    discount,
    shipping: offer.freeShipping ? '🚚 Frete grátis' : '',
    link: offer.affiliateUrl
  };
  const targetAudienceCodes =
    Array.isArray(offer.targetAudienceCodes) &&
      offer.targetAudienceCodes.length
      ? [...offer.targetAudienceCodes]
      : getAudienceCodesForOffer(
        offer,
        config.whatsappAudiences
      );
  const aiRequired = config.aiEnabled !== false;
  const message = aiRequired
    ? ''
    : String(config.messageTemplate || '{title}\n{link}').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  const offerSnapshot = {
    id: offer.id,
    title: offer.title,
    store: offer.store,
    category: offer.category || '',
    price: Number(offer.price),
    originalPrice: Number(
      offer.originalPrice || offer.price
    ),
    affiliateUrl: offer.affiliateUrl,
    image: offer.image || '',
    freeShipping: Boolean(
      offer.freeShipping
    ),
    targetAudienceCodes
  };
  return {
    id: createId('queue'),
    offerId: offer.id,
    offerTitle: offer.title,
    store: offer.store,
    targetAudienceCodes,
    message,
    messageSource: aiRequired ? 'awaiting-ai' : 'template',
    offerSnapshot,
    image: offer.image,
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    sentAt: null,
    error: null
  };
}
