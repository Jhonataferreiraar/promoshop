import { normalizeApiKey, readSecrets } from './secrets.js';
import {
  calculateOfferDiscount,
  getAudienceCodesForOffer,
  getAudienceRoutingCatalog
} from './audienceRouting.js';

/*
 * ==========================================================
 * ESTADO DE DISPONIBILIDADE DA IA
 * ==========================================================
 *
 * Não faz nenhuma chamada extra.
 *
 * O estado é atualizado automaticamente quando
 * o sistema já tenta usar Gemini, OpenAI ou Groq.
 */

const aiAvailability = {
  available: false,
  provider: null,
  model: null,
  lastSuccessAt: null,
  lastFailureAt: null
};

export function getAiAvailability() {
  return {
    ...aiAvailability
  };
}

function markAiAvailable(
  provider,
  model
) {
  aiAvailability.available = true;

  aiAvailability.provider =
    provider || null;

  aiAvailability.model =
    model || null;

  aiAvailability.lastSuccessAt =
    new Date().toISOString();
}

function markAiUnavailable() {
  aiAvailability.available = false;

  aiAvailability.provider = null;

  aiAvailability.model = null;

  aiAvailability.lastFailureAt =
    new Date().toISOString();
}

function calculateDiscount(price, originalPrice) {
  if (!originalPrice || originalPrice <= price) return 0;

  return Math.round(
    (1 - price / originalPrice) * 100
  );
}

function money(value) {
  return Number(value || 0).toLocaleString(
    'pt-BR',
    {
      style: 'currency',
      currency: 'BRL'
    }
  );
}

function comparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const toneProfiles = {
  seller: {
    label: 'vendedor e confiável',
    instruction:
      'Seja persuasivo e seguro. Destaque por que vale conferir, sem exagerar ou pressionar.'
  },

  direct: {
    label: 'direto e objetivo',
    instruction:
      'Use frases muito curtas. Vá direto ao produto e à oportunidade, sem introdução.'
  },

  friendly: {
    label: 'amigável e natural',
    instruction:
      'Escreva como uma recomendação de um amigo, com linguagem próxima e leve.'
  },

  urgent: {
    label: 'urgência responsável',
    instruction:
      'Crie senso de oportunidade porque preço e estoque podem mudar, sem inventar prazo, escassez ou últimas unidades.'
  },

  premium: {
    label: 'elegante e premium',
    instruction:
      'Use uma linguagem refinada, limpa e segura, com poucos emojis e sem parecer publicidade agressiva.'
  },

  playful: {
    label: 'divertido e descontraído',
    instruction:
      'Use energia, humor leve e até três emojis pertinentes, sem infantilizar o texto.'
  },

  story: {
    label: 'mini-história cotidiana',
    instruction:
      'Comece com uma situação cotidiana curta e conecte naturalmente o produto a ela.'
  },

  minimal: {
    label: 'minimalista',
    instruction:
      'Use o mínimo de palavras possível: uma abertura curta e uma chamada direta.'
  }
};

const creativeDirections = [
  'Comece pelo principal benefício percebido no nome do produto.',
  'Comece com uma pergunta curta relacionada ao uso do produto.',
  'Comece com uma situação cotidiana em que o produto poderia ser interessante.',
  'Comece diretamente pelo produto e pela condição de preço.',
  'Comece destacando a economia, sem usar urgência artificial.',
  'Comece com uma observação leve e natural, como uma recomendação entre amigos.',
  'Use uma abertura curta e surpreendente, sem exagerar.',
  'Apresente primeiro o problema cotidiano e depois conecte o produto.'
];

function resolveTone(configuredTone, offer) {
  if (
    configuredTone !== 'varied' &&
    toneProfiles[configuredTone]
  ) {
    return configuredTone;
  }

  const choices =
    Object.keys(toneProfiles);

  const seed =
    `${offer.publicationId || offer.id || ''}|` +
    `${offer.title || ''}|` +
    new Date().toISOString().slice(0, 10);

  const hash = [...seed].reduce(
    (total, character) =>
      (
        (total * 31) +
        character.codePointAt(0)
      ) >>> 0,
    7
  );

  return choices[
    hash % choices.length
  ];
}

function fillLocalPlaceholders(
  template,
  offer
) {
  const discount =
    calculateDiscount(
      Number(offer.price),
      Number(offer.originalPrice)
    );

  let message =
    String(template || '')
      .replace(
        /^```(?:text)?\s*/i,
        ''
      )
      .replace(
        /\s*```$/i,
        ''
      )
      .trim();

  /*
   * Se não existir preço anterior válido,
   * remove qualquer linha relacionada a
   * preço anterior ou desconto.
   */
  if (!discount) {
    message = message
      .split('\n')
      .filter(
        (line) =>
          !line.includes(
            '{originalPrice}'
          ) &&
          !line.includes(
            '{discount}'
          )
      )
      .join('\n');
  }

  const values = {
    title:
      String(
        offer.title || ''
      ).trim(),

    /*
     * No fallback não inventamos benefício.
     */
    benefit: '',

    originalPrice:
      money(
        offer.originalPrice ||
        offer.price
      ),

    price:
      money(offer.price),

    discount,

    shipping:
      offer.freeShipping
        ? '🚚 Frete grátis'
        : '',

    link:
      String(
        offer.affiliateUrl || ''
      ).trim(),

    store:
      String(
        offer.store || ''
      ).trim()
  };

  message = message

    /*
     * Nunca deixa URLs eventualmente
     * escritas pelo modelo.
     */
    .replace(
      /https?:\/\/\S+/gi,
      ''
    )

    .replace(
      /\{(title|benefit|originalPrice|price|discount|shipping|link|store)\}/g,
      (_, key) =>
        values[key] ?? ''
    )

    .replace(
      /\{\w+\}/g,
      ''
    )

    .replace(
      /[ \t]+\n/g,
      '\n'
    )

    .replace(
      /\n{3,}/g,
      '\n\n'
    )

    .split('\n')

    /*
     * Mantém a regra atual do sistema:
     * textos da IA não falam em afiliado.
     */
    .filter(
      (line) =>
        !/afiliad|venda direta/i.test(
          line
        )
    )

    .join('\n')

    .replace(
      /\n{3,}/g,
      '\n\n'
    )

    .trim();

  /*
   * Segurança:
   * garante o link no final caso
   * algum template o tenha removido.
   */
  if (
    values.link &&
    !message.includes(values.link)
  ) {
    message +=
      `\n\n👇 Confira a oferta:\n` +
      values.link;
  }

  return message.slice(
    0,
    1800
  );
}

/*
 * ==========================================================
 * TEXTO LOCAL
 * ==========================================================
 *
 * É usado quando:
 *
 * - Gemini está sem cota;
 * - OpenAI está sem créditos;
 * - Groq atingiu limite;
 * - as APIs estão indisponíveis;
 * - IA foi desativada.
 *
 * Não depende de nenhuma API.
 */
export function generateFallbackOfferMessage(
  offer,
  config
) {
  const template =
    `⚡️ Olha só esse achado!

*{title}*

❌ DE: ~{originalPrice}~
✅ POR: *{price}*

{shipping}

👇 Confira a oferta:
{link}

Oferta: {store}`;

  return fillLocalPlaceholders(
    template,
    offer
  );
}

function finalizeGeneratedMessage(
  generated,
  offer,
  config
) {
  let message =
    String(generated || '')
      .replace(
        /^```(?:json|text)?\s*/i,
        ''
      )
      .replace(
        /\s*```$/i,
        ''
      )
      .trim();

  if (!message) {
    throw new Error(
      'A IA retornou uma mensagem vazia.'
    );
  }

  message = message
    .replace(
      /https?:\/\/\S+/gi,
      '{link}'
    )
    .replace(
      /R\$\s*[\d.,]+/gi,
      '{price}'
    )
    .split('\n')
    .filter(
      (line) =>
        !/afiliad|venda direta/i.test(
          line
        )
    )
    .join('\n')
    .trim();

  const missingFields = [
    '{title}',
    '{price}',
    '{link}'
  ].filter(
    (field) =>
      !message.includes(field)
  );

  if (missingFields.length) {
    const normalizedMessage = comparableText(message);
    const normalizedTitle = comparableText(offer.title);
    const titleWasWritten =
      normalizedTitle &&
      normalizedMessage.includes(normalizedTitle);

    // Alguns modelos obedecem ao formato, mas escrevem o título/preço
    // diretamente. Aproveitamos o texto criativo e só completamos os dados
    // que precisam ser preenchidos pelo sistema. Respostas genéricas, sem o
    // produto, continuam sendo rejeitadas para ativar o fallback seguro.
    if (
      missingFields.includes('{title}') &&
      !titleWasWritten
    ) {
      if (missingFields.length === 3) {
        throw new Error(
          `A IA não criou a mensagem completa (faltou ${missingFields.join(', ')}).`
        );
      }

      message = `*{title}*\n\n${message}`;
    }

    if (missingFields.includes('{price}')) {
      message += '\n\n💰 Por: *{price}*';
    }

    if (missingFields.includes('{link}')) {
      message += '\n\n👉 Confira a oferta:\n{link}';
    }
  }

  if (
    message.includes('{benefit}')
  ) {
    throw new Error(
      'A IA não escreveu o benefício do produto.'
    );
  }

  return fillLocalPlaceholders(
    message,
    offer
  );
}

/*
 * ==========================================================
 * ORDEM DAS IAS
 * ==========================================================
 */
function getProviderOrder(config) {
  const configured =
    Array.isArray(
      config.aiProviderOrder
    )
      ? config.aiProviderOrder
      : [];

  const order =
    configured.length
      ? configured
      : [
          'gemini',
          'openai',
          'groq'
        ];

  return [
    ...new Set(
      order
        .map(
          (provider) =>
            String(
              provider || ''
            )
              .trim()
              .toLowerCase()
        )
        .filter(
          (provider) =>
            [
              'gemini',
              'openai',
              'groq'
            ].includes(provider)
        )
    )
  ];
}

function getProviderModel(
  provider,
  config
) {
  const configuredModels =
    config.aiModels &&
    typeof config.aiModels ===
      'object'
      ? config.aiModels
      : {};

  if (
    provider === 'gemini'
  ) {
    return String(
      configuredModels.gemini ||
      config.aiModel ||
      'gemini-3.5-flash-lite'
    ).trim();
  }

  if (
    provider === 'openai'
  ) {
    return String(
      configuredModels.openai ||
      process.env.OPENAI_MODEL ||
      ''
    ).trim();
  }

  if (
    provider === 'groq'
  ) {
    return String(
      configuredModels.groq ||
      'openai/gpt-oss-20b'
    ).trim();
  }

  return '';
}

/*
 * ==========================================================
 * CHAMADA DE UMA IA
 * ==========================================================
 */
async function callJsonProvider({
  provider,
  model,
  messages,
  temperature = 0.2
}) {
  const secrets =
    await readSecrets();

  /*
   * =========================
   * GEMINI
   * =========================
   */
  if (
    provider === 'gemini'
  ) {
    const apiKey =
      normalizeApiKey(
        secrets.geminiApiKey
      ) ||
      normalizeApiKey(
        process.env.GEMINI_API_KEY
      ) ||
      normalizeApiKey(
        process.env.GOOGLE_API_KEY
      );

    if (!apiKey) {
      throw new Error(
        'Gemini: chave não configurada.'
      );
    }

    if (!model) {
      throw new Error(
        'Gemini: modelo não configurado.'
      );
    }

    const response =
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',

          signal:
            AbortSignal.timeout(
              45_000
            ),

          headers: {
            'Content-Type':
              'application/json',

            'x-goog-api-key':
              apiKey
          },

          body: JSON.stringify({
            systemInstruction:
              messages[0]
                ? {
                    parts: [
                      {
                        text:
                          messages[0]
                            .content
                      }
                    ]
                  }
                : undefined,

            contents:
              messages
                .filter(
                  (message) =>
                    message.role !==
                    'system'
                )
                .map(
                  (message) => ({
                    role:
                      message.role ===
                      'assistant'
                        ? 'model'
                        : 'user',

                    parts: [
                      {
                        text:
                          message.content
                      }
                    ]
                  })
                ),

            generationConfig: {
              temperature,
              maxOutputTokens: 700,
              responseMimeType:
                'application/json'
            }
          })
        }
      );

    const raw =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `Gemini respondeu ${response.status}: ${raw.slice(0, 250)}`
      );
    }

    const payload =
      raw
        ? JSON.parse(raw)
        : {};

    const content =
      payload
        .candidates?.[0]
        ?.content
        ?.parts
        ?.map(
          (part) =>
            part.text || ''
        )
        .join('');

    if (!content) {
      throw new Error(
        'Gemini retornou resposta vazia.'
      );
    }

    return JSON.parse(
      String(content)
        .replace(
          /^```(?:json)?\s*/i,
          ''
        )
        .replace(
          /\s*```$/i,
          ''
        )
        .trim()
    );
  }

  /*
   * =========================
   * OPENAI
   * =========================
   */
  if (
    provider === 'openai'
  ) {
    const apiKey =
      normalizeApiKey(
        secrets.openaiApiKey
      ) ||
      normalizeApiKey(
        process.env.OPENAI_API_KEY
      );

    if (!apiKey) {
      throw new Error(
        'OpenAI: chave não configurada.'
      );
    }

    if (!model) {
      throw new Error(
        'OpenAI: modelo não configurado no painel.'
      );
    }

    const response =
      await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',

          signal:
            AbortSignal.timeout(
              45_000
            ),

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${apiKey}`
          },

          body: JSON.stringify({
            model,
            messages,
            temperature,

            response_format: {
              type:
                'json_object'
            }
          })
        }
      );

    const raw =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `OpenAI respondeu ${response.status}: ${raw.slice(0, 250)}`
      );
    }

    const payload =
      raw
        ? JSON.parse(raw)
        : {};

    const content =
      payload
        .choices?.[0]
        ?.message
        ?.content;

    if (!content) {
      throw new Error(
        'OpenAI retornou resposta vazia.'
      );
    }

    return JSON.parse(
      String(content)
        .replace(
          /^```(?:json)?\s*/i,
          ''
        )
        .replace(
          /\s*```$/i,
          ''
        )
        .trim()
    );
  }

  /*
   * =========================
   * GROQ
   * =========================
   */
  if (
    provider === 'groq'
  ) {
    const apiKey =
      normalizeApiKey(
        secrets.aiApiKey
      ) ||
      normalizeApiKey(
        process.env.AI_API_KEY
      );

    if (!apiKey) {
      throw new Error(
        'Groq: chave não configurada.'
      );
    }

    if (!model) {
      throw new Error(
        'Groq: modelo não configurado.'
      );
    }

    const response =
      await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',

          signal:
            AbortSignal.timeout(
              45_000
            ),

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${apiKey}`
          },

          body: JSON.stringify({
            model,
            messages,
            temperature,

            max_completion_tokens:
              700,

            reasoning_effort:
              model.startsWith(
                'openai/gpt-oss-'
              )
                ? 'low'
                : undefined,

            response_format: {
              type:
                'json_object'
            }
          })
        }
      );

    const raw =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `Groq respondeu ${response.status}: ${raw.slice(0, 250)}`
      );
    }

    const payload =
      raw
        ? JSON.parse(raw)
        : {};

    const content =
      payload
        .choices?.[0]
        ?.message
        ?.content;

    if (!content) {
      throw new Error(
        'Groq retornou resposta vazia.'
      );
    }

    return JSON.parse(
      String(content)
        .replace(
          /^```(?:json)?\s*/i,
          ''
        )
        .replace(
          /\s*```$/i,
          ''
        )
        .trim()
    );
  }

  throw new Error(
    `Provedor desconhecido: ${provider}`
  );
}

/*
 * ==========================================================
 * FALLBACK ENTRE IAS
 * ==========================================================
 */
async function callJsonWithFallback(
  messages,
  config,
  {
    temperature = 0.2
  } = {}
) {
  const providers =
    getProviderOrder(config);

  const errors = [];

  for (
    const provider
    of providers
  ) {
    const model =
      getProviderModel(
        provider,
        config
      );

    try {
      const result =
        await callJsonProvider({
          provider,
          model,
          messages,
          temperature
        });

      /*
       * Uma IA respondeu.
       *
       * A partir daqui o assistente
       * pode aparecer no site.
       */
      markAiAvailable(
        provider,
        model
      );

      console.log(
        `[IA] ${provider} respondeu com sucesso usando ${model || 'modelo não informado'}.`
      );

      return {
        provider,
        model,
        result
      };
    } catch (error) {
      const message =
        String(
          error?.message ||
          error
        );

      errors.push(
        `${provider}: ${message}`
      );

      console.warn(
        `[IA] ${provider} falhou. Tentando próximo provedor: ${message}`
      );
    }
  }

  /*
   * Gemini, OpenAI e Groq
   * falharam.
   *
   * O assistente desaparece do site,
   * mas o publicador continua usando
   * o fallback local.
   */
  markAiUnavailable();

  throw new Error(
    `Todas as IAs falharam: ${errors.join(' | ')}`
  );
}

/*
 * ==========================================================
 * CLASSIFICAÇÃO DO GRUPO
 * ==========================================================
 */
export async function classifyOfferAudience(
  offer,
  config
) {
  const audiences =
    getAudienceRoutingCatalog(
      config.whatsappAudiences
    );

  const thematicAudiences =
    audiences.filter(
      (audience) =>
        !audience.general &&
        !audience.deals
    );

  if (
    !thematicAudiences.length
  ) {
    return getAudienceCodesForOffer(
      offer,
      config.whatsappAudiences
    );
  }

  const discount =
    calculateOfferDiscount(
      offer
    );

  const catalog =
    thematicAudiences
      .map(
        (audience) =>
          `${audience.code} - ${audience.name}`
      )
      .join('\n');

  const prompt = `
Classifique este produto para UM grupo de WhatsApp da PromoShop.

PRODUTO:
Título: ${String(offer.title || '').slice(0, 600)}
Categoria informada: ${String(offer.category || '').slice(0, 300)}
Loja: ${String(offer.store || '').slice(0, 100)}
Desconto: ${discount}%

GRUPOS TEMÁTICOS DISPONÍVEIS:
${catalog}

REGRAS IMPORTANTES:

- Escolha SOMENTE UM grupo temático.
- Analise o produto como um todo.
- Não escolha baseado apenas em uma palavra isolada quando ela puder ter outro significado.
- Não use G01 nesta classificação.
- Não use G10 nesta classificação.
- Não invente códigos.
- Se nenhum grupo temático combinar claramente, responda null.
- Priorize o propósito principal do produto.

Exemplos:

iPhone → G02
Notebook → G02
Air Fryer → G03
Panela → G03
Shampoo → G04
Tênis casual → G05
Ração para cachorro → G06
Brinquedo infantil → G07
Isca de pesca → G08
Corda de escalada → G08
Furadeira → G09
Peça automotiva → G09

RESPONDA APENAS JSON:

{
  "code": "G02",
  "confidence": 0.95
}
`;

  try {
    const {
      result,
      provider
    } =
      await callJsonWithFallback(
        [
          {
            role: 'system',
            content:
              'Você é um classificador rigoroso de produtos para grupos de promoções. Sua prioridade é impedir produtos em grupos errados.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        config,
        {
          temperature: 0
        }
      );

    const requestedCode =
      result?.code
        ? String(
            result.code
          )
            .trim()
            .toUpperCase()
        : '';

    const confidence =
      Number(
        result?.confidence ||
        0
      );

    // A IA pode interpretar uma palavra ambígua de forma diferente do
    // propósito real do produto. O roteador local usa título, categoria e
    // palavras configuradas como segunda barreira e vence quando encontrou
    // um tema claro. Assim uma oferta de casa, por exemplo, não vai para
    // tecnologia só porque o anúncio menciona "smart" em um acessório.
    const localCodes = getAudienceCodesForOffer(
      offer,
      config.whatsappAudiences
    );
    const localThematic = localCodes.find(
      (code) => code !== 'G01' && code !== 'G10'
    );

    const validCodes =
      new Set(
        thematicAudiences.map(
          (audience) =>
            audience.code
        )
      );

    const codes = [];

    if (localThematic && validCodes.has(localThematic)) {
      codes.push(localThematic);
    } else if (
      requestedCode &&
      validCodes.has(requestedCode) &&
      confidence >= 0.75
    ) {
      codes.push(requestedCode);
    }

    /*
     * IA respondeu, mas não
     * teve confiança suficiente.
     */
    if (!codes.length) {
      if (localThematic) {
        codes.push(
          localThematic
        );
      } else if (
        config
          .aiAudienceRoutingRequireMatch
          !== true
      ) {
        codes.push(
          String(
            config
              .aiGeneralAudienceCode ||
            'G01'
          ).toUpperCase()
        );
      }
    }

    /*
     * G10 depende apenas
     * do desconto.
     */
    const dealsAudience =
      audiences.find(
        (audience) =>
          audience.code ===
          String(
            config
              .aiDealsAudienceCode ||
            'G10'
          ).toUpperCase()
      );

    if (dealsAudience) {
      const minimumDiscount =
        Number(
          dealsAudience
            .minDiscount ||
          40
        );

      if (
        minimumDiscount > 0 &&
        discount >=
          minimumDiscount
      ) {
        codes.push(
          dealsAudience.code
        );
      }
    }

    const uniqueCodes = [
      ...new Set(codes)
    ];

    console.log(
      `[ROTEAMENTO IA] "${offer.title}" → ${uniqueCodes.join(', ') || 'nenhum'} (${provider})`
    );

    return uniqueCodes;
  } catch (error) {
    /*
     * TODAS AS IAS FALHARAM.
     *
     * Não trava a publicação.
     * Usa imediatamente o
     * roteador local.
     */
    console.warn(
      `[ROTEAMENTO LOCAL] As IAs não classificaram "${offer.title}". Usando regras locais: ${error.message}`
    );

    const localCodes =
      getAudienceCodesForOffer(
        offer,
        config.whatsappAudiences
      );

    console.log(
      `[ROTEAMENTO LOCAL] "${offer.title}" → ${localCodes.join(', ') || 'nenhum'}`
    );

    return localCodes;
  }
}

/*
 * ==========================================================
 * GERAÇÃO DA MENSAGEM COM IA
 * ==========================================================
 */
export async function generateOfferMessage(
  offer,
  config
) {
  const discount =
    calculateDiscount(
      Number(offer.price),
      Number(
        offer.originalPrice
      )
    );

  const selectedTone =
    resolveTone(
      config.aiTone ||
      'seller',
      offer
    );

  const tone =
    toneProfiles[
      selectedTone
    ];

  const publicationId =
    String(
      offer.publicationId ||
      offer.id ||
      'prévia'
    ).slice(0, 80);

  const creativeHash =
    [
      ...`${publicationId}|${offer.title || ''}`
    ].reduce(
      (
        total,
        character
      ) =>
        (
          (total * 33) +
          character.codePointAt(0)
        ) >>> 0,
      11
    );

  const creativeDirection =
    creativeDirections[
      creativeHash %
      creativeDirections.length
    ];

  const prompt = `
Crie a mensagem COMPLETA de uma oferta em português do Brasil para WhatsApp.

Produto: ${offer.title}
Loja: ${offer.store}
Identificador criativo desta publicação: ${publicationId}
Estilo: ${tone.label}.
Direção do estilo: ${tone.instruction}
Direção criativa exclusiva: ${creativeDirection}

Instruções adicionais do administrador:
${String(
  config.aiInstructions ||
  'Destaque o benefício principal do produto e crie uma chamada para ação curta.'
).slice(0, 3500)}

Prioridade criativa:

- O estilo selecionado e as instruções do administrador são obrigatórios.
- Não produza uma mensagem genérica que poderia servir para qualquer estilo.
- Adapte abertura, vocabulário, ritmo, emojis e chamada para ação.
- Nunca invente informações.

Dados disponíveis:

- preço anterior e desconto: ${discount > 0 ? 'disponíveis' : 'não disponíveis'}
- frete grátis: ${offer.freeShipping ? 'disponível' : 'não informado'}

Regras obrigatórias:

- Retorne somente JSON válido no formato {"message":"mensagem completa"}.
- Mantenha obrigatoriamente {title}, {price} e {link}.
- Use {originalPrice} e {discount} somente quando disponíveis.
- Use {shipping} somente quando houver frete grátis.
- Se usar benefício, escreva o benefício diretamente.
- Nunca devolva {benefit}.
- Não escreva valores de preço, percentuais ou URLs por conta própria.
- A mensagem deve ter no máximo 900 caracteres antes da substituição.
- Use formatação do WhatsApp com moderação.
- Não invente especificações, avaliações, qualidade, estoque, escassez, cupom ou frete.
- Não use "nosso" ou "nossa".
- Não invente urgência.
- Varie abertura, vocabulário e chamada para ação.
- Não escreva nada fora do JSON.
`;

  const messages = [
    {
      role: 'system',
      content:
        'Você é um redator brasileiro criativo especializado em ofertas legítimas para WhatsApp. Crie cada mensagem do zero, seja claro, útil e nunca invente informações.'
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  const {
    result,
    provider
  } =
    await callJsonWithFallback(
      messages,
      config,
      {
        temperature:
          selectedTone ===
          'minimal'
            ? 0.7
            : 1.05
      }
    );

  if (
    !result ||
    typeof result.message !==
      'string'
  ) {
    throw new Error(
      `${provider} não retornou o texto da publicação.`
    );
  }

  return finalizeGeneratedMessage(
    result.message,
    offer,
    config
  );
}

/*
 * ==========================================================
 * ASSISTENTE PÚBLICO DE GRUPOS
 * ==========================================================
 */
export async function recommendWhatsappAudiences(
  userMessage,
  audiences,
  config,
  secrets
) {
  const activeAudiences =
    (
      Array.isArray(audiences)
        ? audiences
        : []
    )
      .filter(
        (audience) =>
          audience.enabled !==
          false
      )
      .map(
        (audience) => ({
          code:
            audience.code,

          name:
            audience.name,

          keywords:
            audience.keywords ||
            []
        })
      );

  if (
    !activeAudiences.length
  ) {
    throw new Error(
      'Nenhum público está disponível.'
    );
  }

  const prompt = `
Você é o assistente da PromoShop.

Sua função é descobrir quais grupos de ofertas combinam com o interesse do usuário.

GRUPOS DISPONÍVEIS:
${activeAudiences
  .map(
    (audience) =>
      `${audience.code} - ${audience.name} - palavras-chave: ${(audience.keywords || []).join(', ')}`
  )
  .join('\n')}

MENSAGEM DO USUÁRIO:
"${String(userMessage || '').slice(0, 1000)}"

REGRAS:

- Escolha apenas grupos da lista acima.
- Escolha no máximo 3 grupos.
- G01 é o grupo de ofertas gerais e só deve ser recomendado quando o interesse for amplo ou indefinido.
- Não invente códigos.
- Responda SOMENTE com JSON.

FORMATO:

{
  "message": "resposta curta e amigável ao usuário",
  "codes": ["G02"]
}
`;

  const {
    result
  } =
    await callJsonWithFallback(
      [
        {
          role: 'system',
          content:
            'Você recomenda grupos da PromoShop e responde somente JSON válido.'
        },
        {
          role: 'user',
          content:
            prompt
        }
      ],
      config,
      {
        temperature: 0.2
      }
    );

  const parsed =
    result;

  if (
    !parsed ||
    typeof parsed !==
      'object'
  ) {
    throw new Error(
      'A IA não retornou uma recomendação válida.'
    );
  }

  const validCodes =
    new Set(
      activeAudiences.map(
        (audience) =>
          String(
            audience.code ||
            ''
          ).toUpperCase()
      )
    );

  const codes =
    Array.isArray(
      parsed.codes
    )
      ? parsed.codes
          .map(
            (code) =>
              String(
                code || ''
              ).toUpperCase()
          )
          .filter(
            (code) =>
              validCodes.has(
                code
              )
          )
          .slice(0, 3)
      : [];

  return {
    message:
      String(
        parsed.message ||
        'Encontrei alguns grupos para você.'
      ).slice(
        0,
        300
      ),

    codes
  };
}
