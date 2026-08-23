import assert from 'node:assert/strict';
import { buildSearchQueryVariants, productSearchRelevance, rankProductSearchResults } from '../server/searchRelevance.js';

const relevant = (query, title, category = '') => productSearchRelevance(query, { title, category }).accepted;

assert.equal(relevant('notebook', 'Notebook Lenovo Ideapad 8GB SSD 256GB', 'Notebooks'), true);
assert.equal(relevant('notebook', 'Laptop Dell Inspiron 15 8GB 256GB', 'Informática'), true);
assert.equal(relevant('notebook', 'Livro Caderno Notebook para Anotações', 'Papelaria'), false);
assert.equal(productSearchRelevance('notebook', { title: 'Notebook — Guia Completo', category: 'LIVROS', source: 'mercado-livre' }).accepted, false);
assert.equal(relevant('notebook', 'Suporte Ergonômico para Notebook', 'Acessórios'), false);
assert.equal(relevant('notebook', 'Carregador Fonte Universal para Laptop', 'Acessórios'), false);
assert.equal(relevant('notebook', 'Mochla Executiva Reforçada para Notebook', 'Acessórios'), false);
assert.equal(relevant('notebook', 'Adaptador Bluetooth USB para Notebook', 'Acessórios'), false);
assert.equal(relevant('suporte notebook', 'Suporte Ergonômico para Notebook', 'Acessórios'), true);
assert.equal(relevant('iphone 15 128gb', 'Apple iPhone 15 128GB Preto', 'Celulares'), true);
assert.equal(relevant('iphone 15 128gb', 'Capinha Transparente para iPhone 15', 'Acessórios'), false);
assert.equal(relevant('iphone 15', 'Smartphone Samsung Galaxy A15 128GB', 'Celulares'), false);
assert.equal(relevant('air fryer mondial', 'Fritadeira Air Fryer Mondial 5 Litros', 'Eletrodomésticos'), true);
assert.equal(relevant('air fryer mondial', 'Forma de Silicone para Air Fryer', 'Acessórios'), false);
assert.equal(relevant('skincare', 'Creme Hidratante Facial com Niacinamida', 'Cuidados com a pele'), true);
assert.equal(relevant('skincare', 'Protetor Solar Facial FPS 60', 'Cuidados com a pele'), true);
assert.equal(relevant('skincare', 'Capa e Película para Celular', 'Acessórios'), false);
assert.equal(relevant('cadeira gamer', 'Cadeira Gamer Reclinável Ergonômica', 'Móveis'), true);
assert.equal(relevant('cadeira gamer', 'Livro sobre universo gamer', 'Livros'), false);

const ranked = rankProductSearchResults('notebook', [
  { id: '1', title: 'Suporte para Notebook', store: 'Loja A', category: 'Acessórios' },
  { id: '2', title: 'Notebook Acer Aspire 5 8GB SSD 512GB', store: 'Loja A', category: 'Notebooks' },
  { id: '3', title: 'Laptop Dell Inspiron 15', store: 'Loja B', category: 'Informática' }
], { strict: true, limitPerStore: 10 });
assert.deepEqual(ranked.map((item) => item.id).sort(), ['2', '3']);

const skincareRanked = rankProductSearchResults('skincare', [
  { id: 'zero', title: 'Skincare Cream Importado', store: 'Shopee', sales: 0, rating: 0, score: 50, sourceRank: 2 },
  { id: 'popular', title: 'Hidratante Facial com Niacinamida', store: 'Shopee', sales: 15000, rating: 4.9, score: 10, sourceRank: 1 }
], { strict: true, limitPerStore: 10 });
assert.equal(skincareRanked[0].id, 'popular');

assert.deepEqual(buildSearchQueryVariants('Notebook Gamer'), ['notebook gamer', 'laptop gamer', 'ultrabook gamer']);
assert.deepEqual(buildSearchQueryVariants('iPhone 15'), ['iphone 15']);

console.log('Filtro de relevância da busca validado.');
