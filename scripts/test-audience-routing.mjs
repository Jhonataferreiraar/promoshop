import assert from 'node:assert/strict';
import { DEFAULT_WHATSAPP_AUDIENCES, getAudienceCodesForOffer } from '../server/audienceRouting.js';

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

const configurableAudiences = structuredClone(DEFAULT_WHATSAPP_AUDIENCES);
const general = configurableAudiences.find((audience) => audience.code === 'G01');
const deals = configurableAudiences.find((audience) => audience.code === 'G10');
general.keywords = ['livro'];
deals.keywords = ['notebook'];
deals.blockedKeywords = ['usado'];

const customRoute = (title, price = 100, originalPrice = 200) => getAudienceCodesForOffer({
  title,
  category: '',
  store: 'Loja de teste',
  price,
  originalPrice
}, configurableAudiences);

assert.equal(customRoute('Produto sem categoria conhecida', 80, 100).includes('G01'), false);
assert.equal(customRoute('Livro de receitas especiais', 80, 100).includes('G01'), true);
assert.equal(customRoute('Notebook gamer novo', 100, 200).includes('G10'), true);
assert.equal(customRoute('Smartphone com grande desconto', 100, 200).includes('G10'), false);
assert.equal(customRoute('Notebook gamer usado', 100, 200).includes('G10'), false);

console.log('Roteamento por palavras editáveis e perfil feminino validado.');
