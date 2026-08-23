import assert from 'node:assert/strict';
import { stripAffiliateDisclosure } from '../server/messageSanitizer.js';

const message = `🔥 Produto em promoção

Por: R$ 99,90

👉 Confira aqui:
https://exemplo.com/oferta

ℹ️ Link de afiliado: a PromoShop pode receber comissão, sem custo adicional para você.`;

const sanitized = stripAffiliateDisclosure(message);
assert.equal(sanitized.includes('Link de afiliado'), false);
assert.equal(sanitized.includes('https://exemplo.com/oferta'), true);
assert.equal(sanitized.includes('R$ 99,90'), true);
assert.equal(stripAffiliateDisclosure('Indicação de afiliado - não é venda direta.'), '');

console.log('Aviso de afiliado removido das mensagens do WhatsApp.');
