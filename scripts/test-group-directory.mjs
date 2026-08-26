import assert from 'node:assert/strict';

import { buildGroupDirectoryMessage, sanitizeGroupDirectoryCodes } from '../server/groupDirectory.js';

const audiences = [
  { code: 'G01', name: 'Ofertas Gerais', whatsappLink: 'https://chat.whatsapp.com/gerais', enabled: true },
  { code: 'G06', name: 'Pet', whatsappLink: 'https://chat.whatsapp.com/pet', enabled: true },
  { code: 'G09', name: 'Inativo', whatsappLink: 'https://chat.whatsapp.com/inativo', enabled: false }
];
const result = buildGroupDirectoryMessage({ title: 'Grupos PromoShop', includedCodes: ['g06', 'G01', 'G09'] }, audiences);

assert.deepEqual(sanitizeGroupDirectoryCodes(['g01', 'G01', 'inválido']), ['G01']);
assert.match(result.message, /Grupos PromoShop/);
assert.match(result.message, /Ofertas Gerais/);
assert.match(result.message, /https:\/\/chat\.whatsapp\.com\/pet/);
assert.doesNotMatch(result.message, /Inativo/);
assert.equal(result.groups.length, 2);

console.log('Divulgação dos grupos: seleção de links e mensagem validadas.');
