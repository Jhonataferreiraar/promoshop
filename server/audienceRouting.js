function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

const audienceRules = {
    G02: {
        name: 'Tecnologia & Games',
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
            'fone bluetooth',
            'fone de ouvido',
            'headphone',
            'earbuds',
            'caixa de som bluetooth',
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

    G03: {
        name: 'Casa & Cozinha',
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
            'moveis',
            'movel',
            'decoracao',
            'cozinha',
            'utensilio cozinha',
            'organizador',
            'organizador'
        ]
    },

    G04: {
        name: 'Beleza & Cabelo',
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
            'beleza',
            'kerastase',
            'kérastase',
            'wella',
            'loreal professionnel',
            'loreal professional',
            'redken',
            'truss',
            'keune',
            'joico',
            'schwarzkopf',
            'alfaparf',
            'moroccanoil'
        ]
    },

    G05: {
        name: 'Moda & Acessórios',
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

    G06: {
        name: 'Pet',
        keywords: [
            'pet shop',
            'pet',
            'pet shop',
            'racao',
            'cachorro',
            'gato',
            'cao',
            'coleira',
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

    G07: {
        name: 'Bebês & Crianças',
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

    G08: {
        name: 'Esporte & Fitness',
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

    G09: {
        name: 'Ferramentas & Automotivo',
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
            'acessorio carro',
            'acessorio automotivo',
            'peca automotiva',
            'peca para carro',
            'acessorio moto',
            'peca para moto',
            'automotivo',
            'automotiva',
            'peca automotiva',
            'acessorio automotivo',
            'pneu',
            'oleo motor',
            'lampada automotiva',
            'multimetro'
        ]
    }
};

export function getAudienceCodesForOffer(offer) {
    const text = normalizeText([
        offer.title,
        offer.category,
        offer.store
    ].filter(Boolean).join(' '));

    /*
     * G01 é o grupo geral.
     * Toda oferta válida também poderá ser publicada nele.
     */
    const codes = new Set(['G01']);

    for (const [code, rule] of Object.entries(audienceRules)) {
        const matched = rule.keywords.some((keyword) =>
            text.includes(normalizeText(keyword))
        );

        if (matched) {
            codes.add(code);
        }
    }

    /*
     * G10 = Ofertas Imperdíveis.
     * Por enquanto usamos 40% ou mais de desconto.
     */
    const price = Number(offer.price || 0);
    const originalPrice = Number(offer.originalPrice || 0);

    const discount =
        originalPrice > price && price > 0
            ? Math.round((1 - price / originalPrice) * 100)
            : Number(offer.score || 0);

    if (discount >= 40) {
        codes.add('G10');
    }

    return [...codes];
}

export function getAudienceName(code) {
    const names = {
        G01: 'Ofertas Gerais',
        G02: 'Tecnologia & Games',
        G03: 'Casa & Cozinha',
        G04: 'Beleza & Cabelo',
        G05: 'Moda & Acessórios',
        G06: 'Pet',
        G07: 'Bebês & Crianças',
        G08: 'Esporte & Fitness',
        G09: 'Ferramentas & Automotivo',
        G10: 'Ofertas Imperdíveis'
    };

    return names[code] || code;
}