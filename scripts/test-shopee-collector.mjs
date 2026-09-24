import assert from 'node:assert/strict';
import { collectShopee } from '../server/collectors.js';

const originalFetch = globalThis.fetch;
const credentials = {
  shopeeAppId: 'test-app-id',
  shopeeAppSecret: 'test_app_secret'
};

function response(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function failure(status = 503, payload = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function product(itemId) {
  return {
    itemId,
    productName: `Produto ${itemId}`,
    productLink: `https://shopee.example/produto/${itemId}`,
    offerLink: `https://shopee.example/afiliado/${itemId}`,
    imageUrl: `https://shopee.example/imagem/${itemId}.jpg`,
    priceMin: 100,
    priceMax: 120,
    priceDiscountRate: 20,
    sales: 10,
    ratingStar: 4.8,
    commissionRate: 5,
    shopId: `shop-${itemId}`,
    shopName: `Loja ${itemId}`
  };
}

function graphqlResult(nodes, { page, hasNextPage, limit = 50 }) {
  return response({
    data: {
      productOfferV2: {
        nodes,
        pageInfo: {
          page,
          limit,
          hasNextPage
        }
      }
    }
  });
}

function requestDetails(init) {
  const query = JSON.parse(init.body).query;
  const keywordMatch = query.match(/keyword:\s*"((?:\\.|[^"\\])*)"/);
  const pageMatch = query.match(/\bpage:\s*(\d+)/);
  const limitMatch = query.match(/\blimit:\s*(\d+)/);
  assert.ok(keywordMatch, `A busca Shopee deve informar a palavra-chave. Query: ${query}`);
  assert.ok(pageMatch, `A busca Shopee deve informar a página. Query: ${query}`);
  assert.ok(limitMatch, `A busca Shopee deve informar o tamanho do lote. Query: ${query}`);

  return {
    keyword: JSON.parse(`"${keywordMatch[1]}"`),
    page: Number(pageMatch[1]),
    limit: Number(limitMatch[1])
  };
}

async function withFetch(mock, callback) {
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPaginationAndDeduplication() {
  const requests = [];
  const activitySink = [];
  const offers = await withFetch(async (_url, init) => {
    const details = requestDetails(init);
    requests.push(details);

    if (details.keyword === 'notebook' && details.page === 1) {
      return graphqlResult([product('notebook-1'), product('shared')], { page: 1, hasNextPage: true });
    }
    if (details.keyword === 'notebook' && details.page === 2) {
      return graphqlResult([product('notebook-2'), product('shared')], { page: 2, hasNextPage: false });
    }
    if (details.keyword === 'celular' && details.page === 1) {
      return graphqlResult([product('shared'), product('celular-1')], { page: 1, hasNextPage: false });
    }
    throw new Error(`Requisição Shopee inesperada: ${details.keyword}, página ${details.page}`);
  }, () => collectShopee({
    enableShopee: true,
    shopeeQueries: 'notebook, celular'
  }, credentials, { fullScan: true, activitySink }));

  assert.deepEqual(
    offers.map((offer) => offer.externalId).sort(),
    ['celular-1', 'notebook-1', 'notebook-2', 'shared'],
    'Itens repetidos entre páginas ou termos devem entrar apenas uma vez.'
  );
  assert.deepEqual(
    requests.map(({ keyword, page, limit }) => `${keyword}:${page}:${limit}`).sort(),
    ['celular:1:50', 'notebook:1:50', 'notebook:2:50'],
    'A coleta completa deve avançar até a última página indicada pela Shopee.'
  );
  assert.equal(Array.isArray(activitySink), true);
}

async function testPartialFailureKeepsSuccessfulResults() {
  const activitySink = [];
  const offers = await withFetch(async (_url, init) => {
    const { keyword, page } = requestDetails(init);
    assert.equal(page, 1);
    assert.equal(requestDetails(init).limit, 50);
    if (keyword === 'falha') return failure();
    if (keyword === 'funciona') {
      return graphqlResult([product('resultado-valido')], { page, hasNextPage: false });
    }
    throw new Error(`Palavra-chave inesperada: ${keyword}`);
  }, () => collectShopee({
    enableShopee: true,
    shopeeQueries: 'falha, funciona'
  }, credentials, { fullScan: true, activitySink }));

  assert.deepEqual(
    offers.map((offer) => offer.externalId),
    ['resultado-valido'],
    'Uma falha isolada não pode descartar os resultados válidos de outros termos.'
  );
}

async function testAllFailuresThrow() {
  await withFetch(async () => failure(503), async () => {
    await assert.rejects(
      () => collectShopee({
        enableShopee: true,
        shopeeQueries: 'sem-resposta'
      }, credentials, { fullScan: true, activitySink: [] }),
      'A coleta deve falhar quando nenhuma busca Shopee obtiver resposta.'
    );
  });
}

async function testPageSizeFallback() {
  const requests = [];
  const offers = await withFetch(async (_url, init) => {
    const details = requestDetails(init);
    requests.push(details);
    if (details.limit === 50) {
      return failure(400, {
        errors: [{ message: 'Maximum limit is 20 for this account.' }]
      });
    }
    assert.equal(details.limit, 20, 'Depois da rejeição do lote de 50, a Shopee deve ser consultada com 20 itens.');
    return graphqlResult([product('fallback-20')], {
      page: details.page,
      hasNextPage: false,
      limit: 20
    });
  }, () => collectShopee({
    enableShopee: true,
    shopeeQueries: 'compatibilidade'
  }, credentials, { fullScan: true, activitySink: [] }));

  assert.deepEqual(offers.map((offer) => offer.externalId), ['fallback-20']);
  assert.deepEqual(
    requests.map(({ page, limit }) => `${page}:${limit}`),
    ['1:50', '1:20'],
    'A atualização completa deve tentar 50 itens e repetir a mesma página com 20 apenas se a conta rejeitar o lote maior.'
  );
}

async function testPerTermAndGlobalRequestCaps() {
  const oneTermRequests = [];
  await withFetch(async (_url, init) => {
    const details = requestDetails(init);
    oneTermRequests.push(details);
    return graphqlResult([product(`longa-${details.page}`)], { page: details.page, hasNextPage: true });
  }, () => collectShopee({
    enableShopee: true,
    shopeeQueries: 'catalogo longo'
  }, credentials, { fullScan: true, activitySink: [] }));

  assert.equal(oneTermRequests.length, 10, 'Cada termo pode consultar no máximo dez páginas.');
  assert.equal(Math.max(...oneTermRequests.map(({ page }) => page)), 10);
  assert.ok(oneTermRequests.every(({ limit }) => limit === 50), 'A atualização completa deve começar com lotes de 50 produtos.');

  const manyTermRequests = [];
  await withFetch(async (_url, init) => {
    const details = requestDetails(init);
    manyTermRequests.push(details);
    return graphqlResult([product(`${details.keyword}-${details.page}`)], { page: details.page, hasNextPage: true });
  }, () => collectShopee({
    enableShopee: true,
    shopeeQueries: 'termo-1, termo-2, termo-3, termo-4, termo-5, termo-6, termo-7, termo-8'
  }, credentials, { fullScan: true, activitySink: [] }));

  assert.equal(manyTermRequests.length, 40, 'Com mais resultados disponíveis, a varredura completa deve aproveitar o teto de 40 solicitações.');
  assert.ok(manyTermRequests.every(({ page }) => page <= 10), 'Nenhum termo pode ultrapassar a décima página.');
  assert.ok(manyTermRequests.every(({ limit }) => limit === 50), 'O teto global deve ser aplicado sobre páginas de 50 produtos.');
}

try {
  await testPaginationAndDeduplication();
  await testPartialFailureKeepsSuccessfulResults();
  await testAllFailuresThrow();
  await testPageSizeFallback();
  await testPerTermAndGlobalRequestCaps();
  console.log('Coletor Shopee: paginação, limites, deduplicação e tolerância a falhas validados.');
} finally {
  globalThis.fetch = originalFetch;
}
