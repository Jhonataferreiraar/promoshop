function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(text, keyword) {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);

  if (!normalizedText || !normalizedKeyword) {
    return false;
  }

  /*
   * Faz correspondência por palavra/frase completa.
   *
   * Evita coisas como:
   * "pet" dentro de outra palavra,
   * "casa" dentro de "casaco",
   * etc.
   */
  const keywordWords = normalizedKeyword.split(' ');
  const textWords = normalizedText.split(' ');

  if (keywordWords.length > 1) {
    // Permite conectivos curtos entre os termos: "tênis de corrida" deve
    // continuar sendo reconhecido como o termo configurado "tênis corrida".
    return textWords.some((_, start) => {
      let cursor = start;
      for (const word of keywordWords) {
        const foundAt = textWords.indexOf(word, cursor);
        if (foundAt < 0 || foundAt - cursor > 2) return false;
        cursor = foundAt + 1;
      }
      return true;
    });
  }

  const pattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedKeyword)}(?=\\s|$)`, 'i');
  return pattern.test(normalizedText);
}

export const DEFAULT_WHATSAPP_AUDIENCES = [
  {
    code: 'G01',
    name: 'Ofertas Gerais',
    whatsappLink: '',
    enabled: true,
    general: true,
    keywords: []
  },

  {
    code: 'G02',
    name: 'Tecnologia & Games',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'smartphone',
      'celular',
      'iphone',
      'galaxy',
      'samsung',
      'motorola',
      'xiaomi',
      'redmi',
      'notebook',
      'laptop',
      'computador',
      'pc gamer',
      'monitor',
      'teclado',
      'mouse',
      'headset',
      'fone',
      'fone bluetooth',
      'smartwatch',
      'tablet',
      'ipad',
      'televisao',
      'smart tv',
      'videogame',
      'video game',
      'playstation',
      'ps4',
      'ps5',
      'xbox',
      'nintendo switch',
      'ssd',
      'hd externo',
      'memoria ram',
      'placa de video',
      'roteador',
      'camera digital',
      'webcam',
      'impressora 3d'
    ]
  },

  {
    code: 'G03',
    name: 'Casa & Cozinha',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'air fryer',
      'fritadeira',
      'cafeteira',
      'microondas',
      'micro ondas',
      'geladeira',
      'fogao',
      'cooktop',
      'liquidificador',
      'batedeira',
      'panela',
      'panela eletrica',
      'aspirador',
      'ventilador',
      'ar condicionado',
      'torneira',
      'chuveiro',
      'cama',
      'colchao',
      'sofa',
      'mesa',
      'cadeira',
      'armario',
      'guarda roupa',
      'decoracao',
      'cozinha',
      'organizador'
    ]
  },

  {
    code: 'G04',
    name: 'Beleza & Cabelo',
    whatsappLink: '',
    enabled: true,
    profile: 'female',
    blockedKeywords: [
      'masculino',
      'masculina para homem',
      'homem',
      'barba',
      'barbeador',
      'cueca',
      'menino',
      'menina',
      'infantil',
      'bebe',
      'crianca'
    ],
    keywords: [
      'shampoo',
      'condicionador',
      'mascara capilar',
      'cabelo',
      'capilar',
      'secador',
      'chapinha',
      'prancha',
      'escova secadora',
      'escova rotativa',
      'modelador',
      'babyliss',
      'maquiagem',
      'batom',
      'base facial',
      'rimel',
      'mascara de cilios',
      'perfume',
      'colonia',
      'skincare',
      'hidratante',
      'protetor solar',
      'serum',
      'creme facial',
      'depilador',
      'beleza',
      'creme de cabelo',
      'creme capilar',
      'leave in',
      'hidratante corporal',
      'moda feminina',
      'roupa feminina',
      'camiseta feminina',
      'blusa feminina',
      'calca feminina',
      'short feminino',
      'vestido',
      'saia',
      'cropped',
      'legging',
      'top feminino',
      'conjunto feminino',
      'tenis feminino',
      'roupa corrida feminina',
      'conjunto fitness feminino'
    ]
  },

  {
    code: 'G05',
    name: 'Moda & Acessórios',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'camiseta',
      'camisa',
      'calca',
      'short',
      'bermuda',
      'vestido',
      'saia',
      'blusa',
      'jaqueta',
      'moletom',
      'roupa',
      'tenis',
      'sapato',
      'sandalia',
      'chinelo',
      'bota',
      'bolsa',
      'mochila',
      'carteira',
      'oculos',
      'relogio',
      'colar',
      'pulseira',
      'anel',
      'brinco',
      'joia'
    ]
  },

  {
    code: 'G06',
    name: 'Pet',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'pet shop',
      'racao',
      'cachorro',
      'gato',
      'cao',
      'coleira',
      'peitoral',
      'areia sanitaria',
      'arranhador',
      'comedouro',
      'bebedouro pet',
      'brinquedo pet',
      'tapete higienico',
      'casinha cachorro',
      'cama pet'
    ]
  },

  {
    code: 'G07',
    name: 'Bebês & Crianças',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'bebe',
      'fralda',
      'mamadeira',
      'chupeta',
      'carrinho bebe',
      'cadeirinha bebe',
      'bebe conforto',
      'berco',
      'brinquedo infantil',
      'boneca',
      'boneco',
      'blocos de montar',
      'lego',
      'carrinho brinquedo',
      'infantil',
      'crianca'
    ]
  },

  {
    code: 'G08',
    name: 'Esporte & Fitness',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'academia',
      'fitness',
      'bicicleta',
      'bike',
      'halter',
      'peso academia',
      'esteira',
      'eliptico',
      'musculacao',
      'yoga',
      'pilates',
      'bola futebol',
      'futebol',
      'volei',
      'basquete',
      'corrida',
      'esporte',
      'tenis corrida',
      'escalada',
      'corda escalada',
      'pesca',
      'isca pesca'
    ]
  },

  {
    code: 'G09',
    name: 'Ferramentas & Automotivo',
    whatsappLink: '',
    enabled: true,
    keywords: [
      'furadeira',
      'parafusadeira',
      'serra eletrica',
      'serra circular',
      'esmerilhadeira',
      'martelete',
      'ferramenta',
      'chave de impacto',
      'compressor',
      'carro',
      'moto',
      'automotivo',
      'automotiva',
      'peca automotiva',
      'acessorio automotivo',
      'pneu',
      'oleo motor',
      'lampada automotiva',
      'multimetro'
    ]
  },

  {
    code: 'G10',
    name: 'Ofertas Imperdíveis',
    whatsappLink: '',
    enabled: true,
    deals: true,
    minDiscount: 40,
    keywords: []
  }
];

export function calculateOfferDiscount(offer) {
  const price = Number(offer?.price || 0);
  const originalPrice = Number(offer?.originalPrice || 0);

  if (
    price > 0 &&
    originalPrice > price
  ) {
    return Math.round(
      (1 - price / originalPrice) * 100
    );
  }

  return 0;
}

function getOfferSearchText(offer) {
  return normalizeText([
    offer?.title,
    offer?.category,
    offer?.store
  ]
    .filter(Boolean)
    .join(' '));
}

function getOfferSearchParts(offer) {
  return {
    title: normalizeText(offer?.title),
    category: normalizeText(offer?.category),
    store: normalizeText(offer?.store),
    all: getOfferSearchText(offer)
  };
}

const FEMALE_PROFILE_SIGNALS = [
  'feminino', 'feminina', 'mulher', 'mulheres', 'vestido', 'saia',
  'cropped', 'legging', 'sutia', 'lingerie', 'maquiagem', 'batom',
  'base facial', 'rimel', 'mascara de cilios', 'shampoo', 'condicionador',
  'mascara capilar', 'creme de cabelo', 'creme capilar', 'leave in',
  'chapinha', 'escova secadora', 'babyliss', 'skincare', 'hidratante',
  'serum', 'creme facial', 'depilador'
];

export function isOfferAllowedForAudience(offer, audience) {
  const searchText = getOfferSearchText(offer);
  const blockedKeywords = Array.isArray(audience?.blockedKeywords)
    ? audience.blockedKeywords
    : [];
  if (blockedKeywords.some((keyword) => containsKeyword(searchText, keyword))) {
    return false;
  }
  if (String(audience?.profile || 'general').toLowerCase() !== 'female') {
    return true;
  }
  return FEMALE_PROFILE_SIGNALS.some((keyword) => containsKeyword(searchText, keyword));
}

function getKeywordMatchScore(
  text,
  audience
) {
  const keywords = Array.isArray(
    audience?.keywords
  )
    ? audience.keywords
    : [];

  let score = 0;
  const matchedKeywords = [];

  for (const keyword of keywords) {
    if (!containsKeyword(text, keyword)) {
      continue;
    }

    const normalizedKeyword =
      normalizeText(keyword);

    /*
     * Frases mais específicas recebem mais pontos.
     *
     * Exemplo:
     * "fone bluetooth" vale mais que apenas "fone".
     */
    const words =
      normalizedKeyword.split(' ').length;

    const keywordScore =
      1 + Math.min(words - 1, 3);

    score += keywordScore;

    matchedKeywords.push(keyword);
  }

  return {
    score,
    matchedKeywords
  };
}

/*
 * ROTEADOR LOCAL / FALLBACK
 *
 * IMPORTANTE:
 *
 * Este não será o roteador principal quando ativarmos
 * o roteamento por IA.
 *
 * Ele serve para:
 *
 * 1. evitar envio para grupo totalmente errado;
 * 2. funcionar caso todas as APIs de IA estejam fora;
 * 3. servir como segunda camada de segurança.
 */
export function getAudienceCodesForOffer(
  offer,
  configuredAudiences =
    DEFAULT_WHATSAPP_AUDIENCES
) {
  const audiences =
    Array.isArray(configuredAudiences) &&
    configuredAudiences.length
      ? configuredAudiences
      : DEFAULT_WHATSAPP_AUDIENCES;

  const searchParts = getOfferSearchParts(offer);

  const discount =
    calculateOfferDiscount(offer);

  const enabledAudiences =
    audiences.filter(
      (audience) =>
        audience &&
        audience.enabled !== false
    );

  /*
   * G01 não participa da classificação temática.
   *
   * G10 também não participa porque depende
   * exclusivamente do desconto.
   */
  const thematicAudiences =
    enabledAudiences.filter((audience) => {
      const code = String(
        audience.code || ''
      )
        .trim()
        .toUpperCase();

      return (
        code &&
        code !== 'G01' &&
        code !== 'G10' &&
        audience.general !== true &&
        audience.deals !== true &&
        isOfferAllowedForAudience(offer, audience)
      );
    });

  const candidates =
    thematicAudiences
      .map((audience) => {
        // O título representa o propósito principal do produto. Categoria e
        // loja servem como confirmação, mas não podem dominar a decisão.
        const titleResult = getKeywordMatchScore(searchParts.title, audience);
        const contextResult = getKeywordMatchScore(
          `${searchParts.category} ${searchParts.store}`,
          audience
        );
        const result = {
          score: titleResult.score * 3 + contextResult.score,
          matchedKeywords: [
            ...new Set([
              ...titleResult.matchedKeywords,
              ...contextResult.matchedKeywords
            ])
          ]
        };

        return {
          audience,
          score: result.score,
          matchedKeywords:
            result.matchedKeywords
        };
      })
      .filter(
        (candidate) =>
          candidate.score > 0
      )
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        return (
          b.matchedKeywords.length -
          a.matchedKeywords.length
        );
      });

  const codes = [];

  /*
   * Uma oferta possui somente UM grupo temático
   * no modo local.
   *
   * Depois a IA será ainda mais precisa.
   */
  if (candidates.length) {
    const selectedCode =
      String(
        candidates[0].audience.code
      )
        .trim()
        .toUpperCase();

    if (selectedCode) {
      codes.push(selectedCode);
    }
  } else {
    /*
     * Se não conseguimos determinar a categoria,
     * ela pode cair em Ofertas Gerais.
     *
     * Isso é muito diferente do comportamento antigo,
     * que adicionava G01 em TODAS as ofertas.
     */
    const general =
      enabledAudiences.find(
        (audience) =>
          String(
            audience.code || ''
          )
            .trim()
            .toUpperCase() === 'G01'
      );

    const generalKeywords = Array.isArray(general?.keywords) ? general.keywords : [];
    const generalMatches = !generalKeywords.length || getKeywordMatchScore(searchParts.all, general).score > 0;

    if (general && generalMatches && isOfferAllowedForAudience(offer, general)) {
      codes.push('G01');
    }
  }

  /*
   * G10 é uma classificação especial.
   *
   * Pode existir junto ao grupo temático.
   *
   * Exemplo:
   *
   * iPhone 50% OFF
   *
   * G02 → Tecnologia
   * G10 → Ofertas Imperdíveis
   */
  const dealsAudience =
    enabledAudiences.find(
      (audience) =>
        String(
          audience.code || ''
        )
          .trim()
          .toUpperCase() === 'G10'
    );

  if (dealsAudience) {
    const minimumDiscount =
      Number(
        dealsAudience.minDiscount ||
        40
      );
    const dealsKeywords = Array.isArray(dealsAudience.keywords) ? dealsAudience.keywords : [];
    const dealsMatch = !dealsKeywords.length || getKeywordMatchScore(searchParts.all, dealsAudience).score > 0;

    if (
      minimumDiscount > 0 &&
      discount >= minimumDiscount &&
      dealsMatch &&
      isOfferAllowedForAudience(offer, dealsAudience) &&
      !codes.includes('G10')
    ) {
      codes.push('G10');
    }
  }

  return codes;
}

/*
 * Retorna os públicos que a IA pode escolher.
 *
 * Vamos utilizar isso posteriormente no ai.js.
 */
export function getAudienceRoutingCatalog(
  configuredAudiences =
    DEFAULT_WHATSAPP_AUDIENCES
) {
  const audiences =
    Array.isArray(configuredAudiences) &&
    configuredAudiences.length
      ? configuredAudiences
      : DEFAULT_WHATSAPP_AUDIENCES;

  return audiences
    .filter(
      (audience) =>
        audience &&
        audience.enabled !== false
    )
    .map((audience) => ({
      code: String(
        audience.code || ''
      )
        .trim()
        .toUpperCase(),

      name: String(
        audience.name || ''
      ).trim(),

      general:
        String(
          audience.code || ''
        )
          .trim()
          .toUpperCase() === 'G01',

      deals:
        String(
          audience.code || ''
        )
          .trim()
          .toUpperCase() === 'G10',

      minDiscount:
        Number(
          audience.minDiscount || 0
        ),

      keywords:
        Array.isArray(
          audience.keywords
        )
          ? audience.keywords
          : [],

      profile: String(audience.profile || 'general').toLowerCase(),

      blockedKeywords: Array.isArray(audience.blockedKeywords)
        ? audience.blockedKeywords
        : []
    }))
    .filter(
      (audience) =>
        audience.code
    );
}

export function getAudienceName(
  code,
  configuredAudiences =
    DEFAULT_WHATSAPP_AUDIENCES
) {
  const audience =
    configuredAudiences.find(
      (item) =>
        String(
          item.code || ''
        )
          .trim()
          .toUpperCase() ===
        String(code || '')
          .trim()
          .toUpperCase()
    );

  return audience?.name || code;
}
