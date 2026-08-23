import assert from 'node:assert/strict';
import { getAudienceCodesForOffer } from '../server/audienceRouting.js';

const route = (title, category = '') => getAudienceCodesForOffer({
  title,
  category,
  store: 'Loja de teste',
  price: 100,
  originalPrice: 120
});

assert.equal(route('Creme de cabelo hidratação profunda').includes('G04'), true);
assert.equal(route('Hidratante corporal feminino 400ml').includes('G04'), true);
assert.equal(route('Vestido feminino longo').includes('G04'), true);
assert.equal(route('Conjunto fitness feminino roupa de corrida').includes('G04'), true);
assert.equal(route('Perfume feminino floral').includes('G04'), true);

assert.equal(route('Hidratante facial masculino').includes('G04'), false);
assert.equal(route('Perfume masculino amadeirado').includes('G04'), false);
assert.equal(route('Camiseta masculina algodão').includes('G04'), false);
assert.equal(route('Shampoo infantil para menina').includes('G04'), false);
assert.equal(route('Barbeador elétrico para homem').includes('G04'), false);

console.log('Roteamento feminino do G04 validado.');
