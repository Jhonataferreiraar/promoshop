import assert from 'node:assert/strict';

import {
  buildMentionAllPayload,
  buildParticipantMentionFallback,
  uniqueParticipantIds
} from '../worker/whatsappMentions.js';
import {
  shouldMentionEveryone,
  uniqueWhatsAppDestinations
} from '../worker/whatsappDestinations.js';

const participants = [
  { id: { _serialized: '5511999999999@c.us' } },
  { id: '5511888888888@c.us' },
  { id: '5511999999999@c.us' },
  { id: { _serialized: '5511777777777@lid' } }
];

assert.deepEqual(
  uniqueParticipantIds(participants, { exclude: ['5511888888888@c.us'] }),
  ['5511999999999@c.us', '5511777777777@lid']
);

const native = buildMentionAllPayload('Oferta especial', participants);
assert.equal(native.message, '@todos\n\nOferta especial');
assert.deepEqual(native.options.mentions, [
  '5511999999999@c.us',
  '5511888888888@c.us',
  '5511777777777@lid'
]);
assert.equal(native.options.extra.nonJidMentions, 1);
assert.equal(native.options.extra.mentionAll, true);
assert.equal(native.participantCount, 3);

const fallback = buildParticipantMentionFallback('Oferta especial', participants);
assert.equal(
  fallback.message,
  '@5511999999999 @5511888888888 @5511777777777\n\nOferta especial'
);
assert.deepEqual(fallback.options.mentions, native.options.mentions);

const sameNameDestinations = [
  { id: '1201@g.us', name: 'PromoShop - Ofertas ⚡' },
  { id: '1202@g.us', name: 'PromoShop - Ofertas ⚡' },
  { id: '1203@newsletter', name: 'PromoShop - Ofertas ⚡' },
  { id: '1201@g.us', name: 'PromoShop - Ofertas ⚡' }
];
assert.deepEqual(
  uniqueWhatsAppDestinations(sameNameDestinations).map((destination) => destination.id),
  ['1201@g.us', '1202@g.us', '1203@newsletter']
);

assert.equal(shouldMentionEveryone({
  enabled: true,
  item: { kind: 'group-directory' },
  destination: { id: '1201@g.us' }
}), true);
assert.equal(shouldMentionEveryone({
  enabled: true,
  item: { kind: 'offer' },
  destination: { id: '1201@g.us' }
}), false);
assert.equal(shouldMentionEveryone({
  enabled: true,
  item: { kind: 'group-directory' },
  destination: { id: '1203@newsletter' }
}), false);

console.log('WhatsApp: marcação de todos os participantes validada.');
