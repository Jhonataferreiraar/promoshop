const stopWords = new Set(['a', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'o', 'os', 'para', 'por', 'um', 'uma']);

const intents = [
  { aliases: ['notebook', 'laptop', 'ultrabook'], accessories: ['adesivo', 'bateria', 'bolsa', 'cabo', 'capa', 'carregador', 'case', 'cooler', 'dobradica', 'fonte', 'livro', 'memoria', 'mesa', 'mochila', 'mouse', 'peca', 'pelicula', 'skin', 'ssd', 'suporte', 'teclado', 'tela'] },
  { aliases: ['celular', 'smartphone', 'iphone'], accessories: ['adaptador', 'bateria', 'cabo', 'camera', 'capinha', 'carregador', 'capa', 'case', 'display', 'pelicula', 'suporte', 'tela'] },
  { aliases: ['airfryer', 'fritadeira'], accessories: ['cesta', 'forma', 'grade', 'papel', 'peca', 'protetor', 'tapete'] },
  { aliases: ['televisao', 'smarttv', 'tv'], accessories: ['adaptador', 'antena', 'cabo', 'controle', 'painel', 'peca', 'receptor', 'suporte'] },
  { aliases: ['fone', 'headphone', 'headset', 'earphone'], accessories: ['almofada', 'borracha', 'cabo', 'capa', 'case', 'estojo', 'peca', 'suporte'] },
  { aliases: ['relogio', 'smartwatch'], accessories: ['cabo', 'carregador', 'pelicula', 'pulseira', 'suporte'] },
  { aliases: ['aspirador', 'roboaspirador'], accessories: ['bateria', 'carregador', 'escova', 'filtro', 'mangueira', 'peca', 'saco'] }
];

export function normalizeSearchText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2').replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value) {
  return normalizeSearchText(value).split(/\s+/).filter((token) => token.length > 1 && !stopWords.has(token));
}

function tokenMatches(titleTokens, queryToken) {
  return titleTokens.some((titleToken) => titleToken === queryToken || (queryToken.length >= 5 && titleToken.length >= 5 && (titleToken.startsWith(queryToken) || queryToken.startsWith(titleToken))));
}

export function productSearchRelevance(query, offer, { strict = true } = {}) {
  const queryText = normalizeSearchText(query);
  const categoryText = normalizeSearchText(offer?.category || '');
  const titleText = normalizeSearchText(`${offer?.title || ''} ${categoryText}`);
  const queryTokens = [...new Set(tokens(query))];
  const titleTokens = tokens(titleText);
  if (!queryTokens.length || !titleTokens.length) return { accepted: false, score: 0, matched: [], missing: queryTokens, reason: 'Sem termos comparáveis' };

  const intent = intents.find((candidate) => candidate.aliases.some((alias) => queryTokens.includes(alias)));
  const requestedAccessories = intent ? intent.accessories.filter((word) => queryTokens.includes(word)) : [];
  const wrongCatalogCategory = Boolean(intent && !requestedAccessories.length && /mercado-livre/i.test(String(offer?.source || '')) && tokens(categoryText).some((token) => ['acessorio', 'acessorios', 'componente', 'componentes', 'livro', 'livros', 'papelaria', 'peca', 'pecas'].includes(token)));
  const intentPosition = intent ? Math.min(...intent.aliases.map((alias) => titleTokens.indexOf(alias)).filter((index) => index >= 0), Number.POSITIVE_INFINITY) : -1;
  const unwantedAccessories = intent && !requestedAccessories.length
    ? intent.accessories.filter((word) => {
      const position = titleTokens.indexOf(word);
      if (position < 0 || queryTokens.includes(word)) return false;
      return position < intentPosition || intent.aliases.some((alias) => titleText.includes(`${word} para ${alias}`));
    })
    : [];
  const intentMatched = !intent || intent.aliases.some((alias) => titleTokens.includes(alias));
  const comparableTokens = queryTokens.filter((token) => !intent?.aliases.includes(token));
  const matched = comparableTokens.filter((token) => tokenMatches(titleTokens, token));
  const missing = comparableTokens.filter((token) => !matched.includes(token));
  const numbersMissing = queryTokens.filter((token) => /\d/.test(token) && !tokenMatches(titleTokens, token));
  const exactPhrase = titleText.includes(queryText);
  const coverage = comparableTokens.length ? matched.length / comparableTokens.length : (intentMatched ? 1 : 0);
  let score = Math.round(coverage * 55 + (intentMatched ? 25 : 0) + (exactPhrase ? 20 : 0));
  if (unwantedAccessories.length) score -= 70;
  if (wrongCatalogCategory) score -= 70;
  if (!intentMatched) score -= 50;
  if (numbersMissing.length) score -= 35;
  score = Math.max(0, Math.min(100, score));

  const accepted = strict
    ? intentMatched && !wrongCatalogCategory && !unwantedAccessories.length && !numbersMissing.length && coverage >= (comparableTokens.length <= 2 ? 1 : 0.75) && score >= 65
    : intentMatched && !numbersMissing.length && coverage >= 0.5 && score >= 45;
  const reason = wrongCatalogCategory ? 'Categoria de catálogo incompatível'
    : unwantedAccessories.length ? `Acessório não solicitado: ${unwantedAccessories.join(', ')}`
    : !intentMatched ? 'Tipo de produto não corresponde'
      : missing.length ? `Termos ausentes: ${missing.join(', ')}` : 'Correspondência relevante';
  return { accepted, score, matched, missing, reason };
}

export function rankProductSearchResults(query, offers, { strict = true, limitPerStore = 10 } = {}) {
  const seen = new Set();
  const ranked = (Array.isArray(offers) ? offers : []).map((offer) => ({
    ...offer,
    relevance: productSearchRelevance(query, offer, { strict })
  })).filter((offer) => offer.relevance.accepted).sort((a, b) => b.relevance.score - a.relevance.score || Number(b.score || 0) - Number(a.score || 0));

  const storeCounts = new Map();
  return ranked.filter((offer) => {
    const fingerprint = `${normalizeSearchText(offer.store)}:${normalizeSearchText(offer.title)}`;
    if (seen.has(fingerprint)) return false;
    const store = normalizeSearchText(offer.store) || 'loja';
    const count = storeCounts.get(store) || 0;
    if (count >= limitPerStore) return false;
    seen.add(fingerprint);
    storeCounts.set(store, count + 1);
    return true;
  });
}
