const stopWords = new Set(['a', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'o', 'os', 'para', 'por', 'um', 'uma']);

const intents = [
  { aliases: ['notebook', 'laptop', 'ultrabook'], accessories: ['adaptador', 'adesivo', 'base', 'bateria', 'bolsa', 'cabo', 'caixa', 'capa', 'carregador', 'case', 'cooler', 'dobradica', 'fonte', 'lente', 'lentes', 'limpa', 'livro', 'memoria', 'mesa', 'microfibra', 'mochila', 'mochla', 'mouse', 'pasta', 'peca', 'pelicula', 'prompter', 'skin', 'som', 'ssd', 'suporte', 'teclado', 'tela', 'telas', 'teleprompter', 'transmissor'], adjacentAccessories: ['adaptador', 'base', 'bolsa', 'capa', 'carregador', 'case', 'cooler', 'mesa', 'mochila', 'mochla', 'mouse', 'pasta', 'prompter', 'suporte', 'teleprompter', 'transmissor'] },
  { aliases: ['skincare'], matchTerms: ['skincare', 'hidratante', 'serum', 'niacinamida', 'retinol', 'retinal', 'acnezil', 'esfoliante', 'demaquilante', 'protetor', 'limpeza', 'acne'], accessories: ['cabo', 'capa', 'case', 'pelicula', 'suporte', 'tela'], alwaysExcludeAccessories: true },
  { aliases: ['celular', 'smartphone'], accessories: ['adaptador', 'bateria', 'cabo', 'camera', 'capinha', 'carregador', 'capa', 'case', 'display', 'pelicula', 'suporte', 'tela'] },
  { aliases: ['iphone'], accessories: ['adaptador', 'bateria', 'cabo', 'camera', 'capinha', 'carregador', 'capa', 'case', 'display', 'pelicula', 'suporte', 'tela'] },
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

export function buildSearchQueryVariants(query, maxVariants = 3) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];

  const queryTokens = normalized.split(/\s+/).filter(Boolean);
  const intent = intents.find((candidate) => candidate.aliases.some((alias) => queryTokens.includes(alias)));
  if (!intent || intent.aliases.length < 2) return [normalized];

  const matchedAlias = intent.aliases.find((alias) => queryTokens.includes(alias));
  const variants = [normalized];
  for (const alias of intent.aliases) {
    if (alias === matchedAlias) continue;
    variants.push(queryTokens.map((token) => token === matchedAlias ? alias : token).join(' '));
  }
  return [...new Set(variants)].slice(0, Math.max(1, Number(maxVariants) || 1));
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
  const intentMatchTerms = intent?.matchTerms || intent?.aliases || [];
  const requestedAccessories = intent ? intent.accessories.filter((word) => queryTokens.includes(word)) : [];
  const wrongCatalogCategory = Boolean(intent && !requestedAccessories.length && /mercado-livre/i.test(String(offer?.source || '')) && tokens(categoryText).some((token) => ['acessorio', 'acessorios', 'componente', 'componentes', 'livro', 'livros', 'papelaria', 'peca', 'pecas'].includes(token)));
  const intentPosition = intent ? Math.min(...intentMatchTerms.map((alias) => titleTokens.indexOf(alias)).filter((index) => index >= 0), Number.POSITIVE_INFINITY) : -1;
  const indirectIntentReference = Boolean(intent && !requestedAccessories.length && intentPosition > 0 && (
    intentPosition > 7 || intentMatchTerms.some((alias) => new RegExp(`\\b(?:para|do|da|de) ${alias}\\b`).test(titleText))
  ));
  const unwantedAccessories = intent && !requestedAccessories.length
    ? intent.accessories.filter((word) => {
      const position = titleTokens.indexOf(word);
      if (position < 0 || queryTokens.includes(word)) return false;
      const adjacentAccessory = Array.isArray(intent.adjacentAccessories) &&
        intent.adjacentAccessories.includes(word) &&
        position > intentPosition &&
        position - intentPosition <= 3;
      return intent.alwaysExcludeAccessories || adjacentAccessory || position < intentPosition || intentMatchTerms.some((alias) => titleText.includes(`${word} para ${alias}`));
    })
    : [];
  const intentMatched = !intent || intentMatchTerms.some((alias) => titleTokens.includes(alias));
  const comparableTokens = queryTokens.filter((token) => !intent?.aliases.includes(token));
  const matched = comparableTokens.filter((token) => tokenMatches(titleTokens, token));
  const missing = comparableTokens.filter((token) => !matched.includes(token));
  const numbersMissing = queryTokens.filter((token) => /\d/.test(token) && !tokenMatches(titleTokens, token));
  const exactPhrase = titleText.includes(queryText);
  const coverage = comparableTokens.length ? matched.length / comparableTokens.length : (intentMatched ? 1 : 0);
  let score = Math.round(coverage * 55 + (intentMatched ? 25 : 0) + (exactPhrase ? 20 : 0));
  if (unwantedAccessories.length) score -= 70;
  if (indirectIntentReference) score -= 70;
  if (wrongCatalogCategory) score -= 70;
  if (!intentMatched) score -= 50;
  if (numbersMissing.length) score -= 35;
  score = Math.max(0, Math.min(100, score));

  const accepted = strict
    ? intentMatched && !wrongCatalogCategory && !unwantedAccessories.length && !indirectIntentReference && !numbersMissing.length && coverage >= (comparableTokens.length <= 2 ? 1 : 0.75) && score >= 65
    : intentMatched && !indirectIntentReference && !numbersMissing.length && coverage >= 0.5 && score >= 45;
  const reason = wrongCatalogCategory ? 'Categoria de catálogo incompatível'
    : unwantedAccessories.length ? `Acessório não solicitado: ${unwantedAccessories.join(', ')}`
    : indirectIntentReference ? 'Produto citado apenas como compatibilidade'
    : !intentMatched ? 'Tipo de produto não corresponde'
      : missing.length ? `Termos ausentes: ${missing.join(', ')}` : 'Correspondência relevante';
  return { accepted, score, matched, missing, reason };
}

export function rankProductSearchResults(query, offers, { strict = true, limitPerStore = 10 } = {}) {
  const seen = new Set();
  const ranked = (Array.isArray(offers) ? offers : []).map((offer) => ({
    ...offer,
    relevance: productSearchRelevance(query, offer, { strict })
  })).filter((offer) => offer.relevance.accepted).map((offer) => ({
    ...offer,
    hasPromotion: Number(offer.score || 0) > 0,
    platformRelevanceScore: Math.round((
      offer.relevance.score +
      Math.min(40, Math.log10(Math.max(0, Number(offer.sales || 0)) + 1) * 10) +
      Math.min(10, Math.max(0, Number(offer.rating || 0)) * 2) +
      Math.min(5, Math.max(0, Number(offer.score || 0)) * 0.05)
    ) * 10) / 10
  })).sort((a, b) =>
    Number(b.hasPromotion) - Number(a.hasPromotion) ||
    Number(b.sales || 0) - Number(a.sales || 0) ||
    b.platformRelevanceScore - a.platformRelevanceScore ||
    Number(b.rating || 0) - Number(a.rating || 0) ||
    Number(b.score || 0) - Number(a.score || 0) ||
    Number(a.sourceRank || Number.MAX_SAFE_INTEGER) - Number(b.sourceRank || Number.MAX_SAFE_INTEGER)
  );

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
