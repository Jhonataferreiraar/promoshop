import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTarget = path.join(
  root,
  'node_modules',
  'whatsapp-web.js',
  'src',
  'util',
  'Injected',
  'Utils.js'
);

const brokenCall = 'mediaMetadata: msg.avParams(),';
const fixedCall = "mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg),";

export async function patchWhatsappWeb(target = defaultTarget) {
  const source = await readFile(target, 'utf8');

  if (source.includes(fixedCall)) {
    return { changed: false, target };
  }

  if (!source.includes(brokenCall)) {
    throw new Error(
      'A estrutura do whatsapp-web.js mudou. A correção de mídia do canal precisa ser revisada.'
    );
  }

  await writeFile(target, source.replace(brokenCall, fixedCall), 'utf8');
  return { changed: true, target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await patchWhatsappWeb();
  console.log(
    result.changed
      ? 'Compatibilidade de imagens em canais do WhatsApp aplicada.'
      : 'Compatibilidade de imagens em canais do WhatsApp já estava aplicada.'
  );
}
