import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { patchWhatsappWeb } from './patch-whatsapp-web.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'promoshop-whatsapp-patch-'));
const target = path.join(directory, 'Utils.js');
const lidTarget = path.join(directory, 'Utils-lid.js');

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

  await writeFile(
    lidTarget,
    [
      'window.WWebJS = {};',
      'window.WWebJS.sendMessage = async () => window.require(\'WAWebCollections\').Msg.get(newMsgKey._serialized);',
      'window.WWebJS.editMessage = async () => window.require(\'WAWebCollections\').Msg.get(msg.id._serialized);',
      '    window.WWebJS.getChats = async () => {};'
    ].join('\n'),
    'utf8'
  );

  const lidFirst = await patchWhatsappWeb(lidTarget);
  assert.equal(lidFirst.changed, true);
  const lidPatched = await readFile(lidTarget, 'utf8');
  assert.match(lidPatched, /getMsgKeyId = \(key\)/);
  assert.match(lidPatched, /Msg\.get\(window\.WWebJS\.getMsgKeyId\(newMsgKey\)\)/);
  assert.match(lidPatched, /Msg\.get\(window\.WWebJS\.getMsgKeyId\(msg\.id\)\)/);
  const lidSecond = await patchWhatsappWeb(lidTarget);
  assert.equal(lidSecond.changed, false);
  console.log('Correção automática do canal do WhatsApp validada.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
