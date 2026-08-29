import assert from 'node:assert/strict';

import { createPinnedLookup, isPublicRemoteAddress, validateRemoteHttpsUrl } from '../server/safeRemote.js';

for (const address of [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '::1',
  'fc00::1',
  'fe80::1',
  '64:ff9b::7f00:1',
  '2002:7f00:1::',
  '::ffff:7f00:1',
  '::ffff:127.0.0.1'
]) assert.equal(isPublicRemoteAddress(address), false, `${address} deveria ser bloqueado`);

assert.equal(isPublicRemoteAddress('1.1.1.1'), true);
assert.equal(isPublicRemoteAddress('2606:4700:4700::1111'), true);
assert.equal(validateRemoteHttpsUrl('https://images.example.com/oferta.jpg').hostname, 'images.example.com');
assert.throws(() => validateRemoteHttpsUrl('http://images.example.com/oferta.jpg'), /HTTPS/);
assert.throws(() => validateRemoteHttpsUrl('https://localhost/oferta.jpg'), /não é público/);
assert.throws(() => validateRemoteHttpsUrl('https://usuario:senha@example.com/oferta.jpg'), /HTTPS/);
assert.throws(() => validateRemoteHttpsUrl('https://example.com:8443/oferta.jpg'), /porta/);

const pinnedLookup = createPinnedLookup({ address: '1.1.1.1', family: 4 });
await new Promise((resolve, reject) => pinnedLookup('example.com', { all: true }, (error, addresses) => {
  if (error) return reject(error);
  assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]);
  resolve();
}));
await new Promise((resolve, reject) => pinnedLookup('example.com', {}, (error, address, family) => {
  if (error) return reject(error);
  assert.equal(address, '1.1.1.1');
  assert.equal(family, 4);
  resolve();
}));

console.log('Downloads externos: protocolo, portas e redes privadas validados.');
