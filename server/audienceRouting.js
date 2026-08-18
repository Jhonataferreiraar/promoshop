function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export const DEFAULT_WHATSAPP_AUDIENCES = [
  {
    code: 'G01',
    name: 'Ofertas Gerais',
    whatsappLink: '',
    enabled: true,
    always: true,
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
      'bluetooth',
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
      'nintendo',
      'switch',
      'ssd',
      'hd externo',
      'memoria ram',
      'placa de video',
      'roteador',
      'camera digital',
      'webcam'
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
      'micro-ondas',
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
      'casa',
      'organizador'
    ]
  },

  {
    code: 'G04',
    name: 'Beleza & Cabelo',
    whatsappLink: '',
    enabled: true,
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
      'barbeador',
      'depilador',
      'beleza'
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
      'pet',
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
      'brinquedo',
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
      'tenis corrida'
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
    minDiscount: 40,
    keywords: []
  }
];

export function getAudienceCodesForOffer(
  offer,
  configuredAudiences = DEFAULT_WHATSAPP_AUDIENCES
) {
  const audiences =
    Array.isArray(configuredAudiences) &&
    configuredAudiences.length
      ? configuredAudiences
      : DEFAULT_WHATSAPP_AUDIENCES;

  const text = normalizeText([
    offer.title,
    offer.category,
    offer.store
  ].filter(Boolean).join(' '));

  const price = Number(offer.price || 0);
  const originalPrice = Number(offer.originalPrice || 0);

  const discount =
    originalPrice > price && price > 0
      ? Math.round((1 - price / originalPrice) * 100)
      : Number(offer.score || 0);

  const codes = new Set();

  for (const audience of audiences) {
    if (audience.enabled === false) {
      continue;
    }

    const code = String(audience.code || '')
      .trim()
      .toUpperCase();

    if (!code) {
      continue;
    }

    if (audience.always === true) {
      codes.add(code);
      continue;
    }

    if (
      Number(audience.minDiscount || 0) > 0 &&
      discount >= Number(audience.minDiscount)
    ) {
      codes.add(code);
    }

    const keywords = Array.isArray(audience.keywords)
      ? audience.keywords
      : [];

    const matched = keywords.some((keyword) =>
      text.includes(normalizeText(keyword))
    );

    if (matched) {
      codes.add(code);
    }
  }

  /*
   * Segurança:
   * se G01 existir e estiver ativo,
   * toda oferta também vai para Ofertas Gerais.
   */
  const general = audiences.find(
    (audience) =>
      String(audience.code || '').toUpperCase() === 'G01' &&
      audience.enabled !== false
  );

  if (general) {
    codes.add('G01');
  }

  return [...codes];
}

export function getAudienceName(
  code,
  configuredAudiences = DEFAULT_WHATSAPP_AUDIENCES
) {
  const audience = configuredAudiences.find(
    (item) =>
      String(item.code || '').toUpperCase() ===
      String(code || '').toUpperCase()
  );

  return audience?.name || code;
}