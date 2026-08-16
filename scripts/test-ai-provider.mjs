import assert from 'node:assert/strict';
import { generateOfferMessage } from '../server/ai.js';

process.env.AI_API_KEY = 'REDACTED_GROQ_KEY';
process.env.GEMINI_API_KEY = 'AIza_test_key_not_real_123456789';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(options.headers.Authorization, 'Bearer REDACTED_GROQ_KEY');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'openai/gpt-oss-20b');
  const sentText = body.messages.map((message) => message.content).join('\n');
  assert.match(sentText, /Fone Bluetooth Teste/);
  assert.match(sentText, /Loja de Teste/);
  assert.doesNotMatch(sentText, /https:\/\/afiliado\.example/);
  assert.doesNotMatch(sentText, /11999999999/);
  assert.doesNotMatch(sentText, /Modelo preferido do administrador/);
  return new Response(JSON.stringify({
    choices: [{ message: { content: '{"message":"🎧 Um som mais livre para acompanhar sua rotina.\\n\\n*{title}* está por *{price}* e merece uma olhada.\\n\\nConfira aqui 👇\\n{link}"}' } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

try {
  const message = await generateOfferMessage({
    title: 'Fone Bluetooth Teste',
    store: 'Loja de Teste',
    price: 99.9,
    originalPrice: 149.9,
    affiliateUrl: 'https://afiliado.example/produto',
    phone: '11999999999',
    freeShipping: true,
    publicationId: 'publicacao-groq-1'
  }, {
    aiProvider: 'groq',
    aiModel: 'openai/gpt-oss-20b',
    aiTone: 'seller',
    aiInstructions: 'Use poucos emojis.'
  });
  assert.match(message, /Fone Bluetooth Teste/);
  assert.match(message, /https:\/\/afiliado\.example\/produto/);
  assert.match(message, /Um som mais livre/);

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(options.headers['x-goog-api-key'], 'AIza_test_key_not_real_123456789');
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.match(body.contents[0].parts[0].text, /Fone Bluetooth Teste/);
    assert.match(body.contents[0].parts[0].text, /Prioridade criativa/);
    assert.match(body.contents[0].parts[0].text, /claramente perceptíveis/);
    assert.match(body.contents[0].parts[0].text, /publicacao-gemini-2/);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"message":"✨ Praticidade para sua rotina, com um texto realmente amigável e natural.\\n\\n*{title}* chegou por *{price}*.\\n\\nDá uma olhada 👇\\n{link}"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const geminiMessage = await generateOfferMessage({
    title: 'Fone Bluetooth Teste',
    store: 'Loja de Teste',
    price: 99.9,
    originalPrice: 149.9,
    affiliateUrl: 'https://afiliado.example/produto',
    freeShipping: true,
    publicationId: 'publicacao-gemini-2'
  }, {
    aiProvider: 'gemini',
    aiModel: 'gemini-2.5-flash-lite',
    aiTone: 'friendly',
    aiInstructions: 'Use poucos emojis.'
  });
  assert.match(geminiMessage, /Praticidade para sua rotina/);
  assert.match(geminiMessage, /Fone Bluetooth Teste/);
  assert.match(geminiMessage, /R\$\s*99,90/);
  assert.match(geminiMessage, /https:\/\/afiliado\.example\/produto/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"message":"Texto sem os campos obrigatórios"}' }] } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(
    generateOfferMessage({
      title: 'Produto sem padrão',
      store: 'Loja',
      price: 10,
      affiliateUrl: 'https://afiliado.example/produto',
      publicationId: 'publicacao-invalida'
    }, {
      aiProvider: 'gemini',
      aiModel: 'gemini-3.5-flash-lite',
      aiTone: 'varied'
    }),
    /não criou a mensagem completa/
  );

  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'resposta que não é JSON' }] } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(
    generateOfferMessage({
      title: 'Produto com resposta inválida',
      store: 'Loja',
      price: 10,
      affiliateUrl: 'https://afiliado.example/produto',
      publicationId: 'publicacao-json-invalido'
    }, {
      aiProvider: 'gemini',
      aiModel: 'gemini-3.5-flash-lite',
      aiTone: 'varied'
    }),
    /resposta incompleta ou inválida/
  );
  console.log('Integração da IA externa validada.');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
}
