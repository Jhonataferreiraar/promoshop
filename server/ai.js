import { readSecrets } from './secrets.js';

function calculateDiscount(price, originalPrice) {
  if (!originalPrice || originalPrice <= price) return 0;
  return Math.round((1 - price / originalPrice) * 100);
}

function money(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function detectCategory(title) {
  const text = String(title || '').toLowerCase();
  const groups = [
    ['auto', /carro|automot|radiador|ecosport|acelerador|veículo|motocicl|pneu|farol|para-choque|retrovisor/],
    ['electronics', /fone|celular|smartphone|tablet|notebook|computador|câmera|camera|usb|bluetooth|wifi|projetor|monitor|ssd|processador/],
    ['home', /cozinha|casa|organizador|lâmpada|lampada|tapete|banheiro|quarto|mesa|cadeira|panela/],
    ['fashion', /vestido|camisa|calça|blusa|sapato|sandália|chinelo|bolsa|carteira|joia|pulseira/],
    ['beauty', /shampoo|sérum|serum|maquiagem|cosmético|cosmetico|cabelo|perfume|creme|beleza/],
    ['tools', /ferramenta|furadeira|parafusadeira|solda|alicate|chave|broca|grampeador/],
    ['pets', /pet|cachorro|gato|coleira|arnês|arnes|aquário|aquario/],
    ['kids', /infantil|criança|crianca|bebê|bebe|brinquedo|boneco|pelúcia|pelucia/]
  ];
  return groups.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

export async function generateOfferMessage(offer, config) {
  const provider = String(config.aiProvider || 'groq').trim().toLowerCase();
  if (!['groq', 'ollama'].includes(provider)) throw new Error('Escolha Groq ou Ollama como provedor da IA.');
  const model = String(process.env.AI_MODEL || config.aiModel || (provider === 'groq' ? 'openai/gpt-oss-20b' : 'qwen2.5:3b')).trim();
  if (!model) throw new Error('Informe o modelo da IA no painel.');
  const link = String(offer.affiliateUrl || '').trim();
  const discount = calculateDiscount(Number(offer.price), Number(offer.originalPrice));
  const toneLabels = {
    direct: 'direto, curto e objetivo',
    friendly: 'amigável, natural e próximo',
    seller: 'persuasivo, animado e confiável, sem exageros'
  };
  const tone = toneLabels[config.aiTone] || toneLabels.seller;
  const prompt = `Classifique este produto para que um sistema crie uma mensagem de oferta em português do Brasil.

Produto: ${offer.title}
Loja: ${offer.store}
Tom: ${tone}.
Instruções adicionais: ${String(config.aiInstructions || 'Destaque o benefício principal do produto e crie uma chamada para ação curta.').slice(0, 800)}

Regras obrigatórias:
- Retorne somente JSON válido no formato {"category":"general","angle":"deal","cta":"check"}.
- category deve ser somente: auto, electronics, home, fashion, beauty, tools, pets, kids ou general.
- angle deve ser somente: deal, practical ou upgrade.
- cta deve ser somente: check, discover ou take.
- Não escreva nenhuma frase livre.`;

  const messages = [
    { role: 'system', content: 'Você é um redator brasileiro especializado em ofertas legítimas para WhatsApp. Seja claro, útil e nunca invente informações.' },
    { role: 'user', content: prompt }
  ];
  let response;
  if (provider === 'groq') {
    const secrets = await readSecrets();
    const apiKey = String(process.env.AI_API_KEY || secrets.aiApiKey || '').trim();
    if (!apiKey) throw new Error('Informe a chave da Groq no painel.');
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.5,
        max_completion_tokens: 120,
        reasoning_effort: model.startsWith('openai/gpt-oss-') ? 'low' : undefined,
        response_format: { type: 'json_object' }
      })
    });
  } else {
    const endpoint = String(config.aiOllamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: 'json', messages, options: { temperature: 0.5, num_predict: 72 } })
    });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${provider === 'groq' ? 'Groq' : 'IA local'} respondeu ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ''}`);
  }
  const payload = await response.json();
  let creative = {};
  try {
    const content = provider === 'groq' ? payload.choices?.[0]?.message?.content : (payload.message?.content || payload.response);
    const jsonText = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    creative = JSON.parse(jsonText || '{}');
  } catch {}
  const allowedCategories = ['auto', 'electronics', 'home', 'fashion', 'beauty', 'tools', 'pets', 'kids', 'general'];
  const category = detectCategory(offer.title) || (allowedCategories.includes(creative.category) ? creative.category : 'general');
  const angle = ['deal', 'practical', 'upgrade'].includes(creative.angle) ? creative.angle : 'deal';
  const ctaStyle = ['check', 'discover', 'take'].includes(creative.cta) ? creative.cta : 'check';
  const categoryCopy = {
    auto: { emoji: '🚗', deal: 'Uma boa oportunidade para o seu veículo', practical: 'Praticidade para cuidar do seu veículo', upgrade: 'Um cuidado a mais para o seu veículo' },
    electronics: { emoji: '⚡', deal: 'Tecnologia com uma condição interessante', practical: 'Tecnologia para facilitar o seu dia', upgrade: 'Um upgrade para a sua rotina' },
    home: { emoji: '🏠', deal: 'Um achado para deixar sua casa melhor', practical: 'Mais praticidade para a sua casa', upgrade: 'Uma novidade para renovar seu espaço' },
    fashion: { emoji: '✨', deal: 'Um achado para renovar o visual', practical: 'Uma escolha versátil para o dia a dia', upgrade: 'Um toque novo para o seu estilo' },
    beauty: { emoji: '💜', deal: 'Uma oportunidade para sua rotina de cuidados', practical: 'Cuidado e praticidade para o dia a dia', upgrade: 'Um novo aliado para seus cuidados' },
    tools: { emoji: '🛠️', deal: 'Uma ferramenta com preço interessante', practical: 'Mais praticidade para seus projetos', upgrade: 'Um reforço para a sua caixa de ferramentas' },
    pets: { emoji: '🐾', deal: 'Um achado para quem cuida dos pets', practical: 'Mais praticidade para cuidar do seu pet', upgrade: 'Um mimo novo para o seu pet' },
    kids: { emoji: '🎈', deal: 'Uma oportunidade para a criançada', practical: 'Uma escolha prática para os pequenos', upgrade: 'Uma novidade para divertir os pequenos' },
    general: { emoji: '🔥', deal: 'Uma oferta que merece sua atenção', practical: 'Uma opção prática para o dia a dia', upgrade: 'Uma novidade que pode valer a pena' }
  };
  const ctaCopy = { check: 'Confira os detalhes da oferta', discover: 'Veja o produto e saiba mais', take: 'Acesse a oferta enquanto estiver disponível' };
  const headline = categoryCopy[category][angle];
  const cta = ctaCopy[ctaStyle];
  const price = money(offer.price);
  const originalPrice = money(offer.originalPrice || offer.price);
  const priceBlock = discount > 0
    ? `De: ~${originalPrice}~\nPor: *${price}* — ${discount}% OFF`
    : `Por: *${price}*`;
  return `${categoryCopy[category].emoji} *${headline}*\n\n*${offer.title}*\n\n${priceBlock}${offer.freeShipping ? '\n🚚 Frete grátis' : ''}\n\n🛒 ${cta}:\n${link}\n\n_Preço e estoque podem mudar._`;
}
