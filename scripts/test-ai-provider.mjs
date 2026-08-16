import assert from 'node:assert/strict';
import { generateOfferMessage } from '../server/ai.js';

process.env.AI_API_KEY = 'REDACTED_GROQ_KEY';

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
    freeShipping: true
  }, {
    aiProvider: 'groq',
    aiModel: 'openai/gpt-oss-20b',
    aiTone: 'seller',
    aiInstructions: 'Use poucos emojis.'
  });
  assert.match(message, /Fone Bluetooth Teste/);
  assert.match(message, /https:\/\/afiliado\.example\/produto/);
  assert.match(message, /Um som mais livre/);
  console.log('Integração da IA externa validada.');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.AI_API_KEY;
}
