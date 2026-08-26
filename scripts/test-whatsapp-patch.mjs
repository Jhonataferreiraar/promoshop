import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { patchWhatsappWeb } from './patch-whatsapp-web.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'promoshop-whatsapp-patch-'));
const target = path.join(directory, 'Utils.js');

try {
  await writeFile(
    target,
    "const payload = { mediaMetadata: msg.avParams(), mediaHandle: 'teste' };\n",
    'utf8'
  );

  const first = await patchWhatsappWeb(target);
  assert.equal(first.changed, true);

  const patched = await readFile(target, 'utf8');
  assert.match(
    patched,
    /WAWebMediaMetadata'\)\.mediaMetadata\(msg\)/
  );
  assert.doesNotMatch(patched, /msg\.avParams\(\)/);

  const second = await patchWhatsappWeb(target);
  assert.equal(second.changed, false);
  console.log('Correção automática do canal do WhatsApp validada.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
