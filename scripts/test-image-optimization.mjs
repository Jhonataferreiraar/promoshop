import assert from 'node:assert/strict';
import { optimizedProductImage } from '../src/imageOptimization.js';

assert.equal(
  optimizedProductImage('https://cf.shopee.com.br/file/example', 450),
  'https://cf.shopee.com.br/file/example@resize_w450_nl.webp'
);
assert.equal(
  optimizedProductImage('https://ae-pic-a1.aliexpress-media.com/kf/example.jpg', 350),
  'https://ae-pic-a1.aliexpress-media.com/kf/example.jpg_450x450q75.jpg_.webp'
);
assert.equal(
  optimizedProductImage('https://http2.mlstatic.com/example.webp', 450),
  'https://http2.mlstatic.com/example.webp'
);
assert.equal(optimizedProductImage('not-a-url', 450), 'not-a-url');

console.log('Imagens públicas: URLs responsivas validadas.');
