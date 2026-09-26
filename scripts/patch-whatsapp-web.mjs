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
const msgKeyHelperMarker = 'window.WWebJS.getMsgKeyId = (key) =>';
const mediaInternalIdPatchMarker = 'delete message.__x_id;';
const mediaInternalIdPatchAnchor = `        };\n\n        // Bot's won't reply if canonicalUrl is set (linking)`;
const mediaInternalIdPatch = `        };\n\n        // MediaData exposes an internal identifier that collides with the\n        // outgoing message model identifier in newer WhatsApp Web builds.\n        // Remove it before Msg.modelClass initializes the outgoing message.\n        delete message.__x_id;\n\n        // Bot's won't reply if canonicalUrl is set (linking)`;
const msgKeyHelper = `    /**
     * WhatsApp Web renamed the serialized message-key field from
     * _serialized to $1 in newer builds. Keep both names available so a
     * missing key never reaches IndexedDB as Msg.get(undefined).
     */
    window.WWebJS.getMsgKeyId = (key) =>
        key?._serialized ?? key?.$1 ?? undefined;
`;

function applyLidCompatibilityPatch(source) {
  // The media-only fixture used by the unit test is intentionally tiny. The
  // compatibility patch is applied only to the real injected Utils.js,
  // identified by the getChats binding below.
  const anchor = '    window.WWebJS.getChats = async () => {';
  if (!source.includes(anchor) || source.includes(msgKeyHelperMarker)) {
    return { source, changed: false };
  }

  let patched = source.replace(anchor, `${msgKeyHelper}${anchor}`);
  const replacements = [
    [
      ".Msg.get(newMsgKey._serialized);",
      ".Msg.get(window.WWebJS.getMsgKeyId(newMsgKey));"
    ],
    [
      ".Msg.get(msg.id._serialized);",
      ".Msg.get(window.WWebJS.getMsgKeyId(msg.id));"
    ]
  ];
  for (const [from, to] of replacements) patched = patched.replaceAll(from, to);
  return { source: patched, changed: patched !== source };
}

function applyMediaInternalIdCompatibilityPatch(source) {
  if (source.includes(mediaInternalIdPatchMarker)) {
    return { source, changed: false };
  }

  // This patch targets the real outgoing-message model. Keep small test
  // fixtures and future unrelated files untouched when they do not expose it.
  if (!source.includes('window.WWebJS.sendMessage = async') || !source.includes('const message = {')) {
    return { source, changed: false };
  }

  if (!source.includes(mediaInternalIdPatchAnchor)) {
    throw new Error(
      'A estrutura do whatsapp-web.js mudou. A correção do identificador interno de mídia precisa ser revisada.'
    );
  }

  return {
    source: source.replace(mediaInternalIdPatchAnchor, mediaInternalIdPatch),
    changed: true
  };
}

export async function patchWhatsappWeb(target = defaultTarget) {
  const source = await readFile(target, 'utf8');
  let patched = source;
  let changed = false;
  const patches = [];

  if (patched.includes(brokenCall)) {
    patched = patched.replace(brokenCall, fixedCall);
    changed = true;
    patches.push('compatibilidade de imagens em canais');
  } else if (!patched.includes(fixedCall) && patched.includes('WAWebNewsletterSendMessageJob')) {
    throw new Error(
      'A estrutura do whatsapp-web.js mudou. A correção de mídia do canal precisa ser revisada.'
    );
  }

  const lidPatch = applyLidCompatibilityPatch(patched);
  if (lidPatch.changed) {
    patched = lidPatch.source;
    changed = true;
    patches.push('compatibilidade com IDs LID');
  }

  const mediaInternalIdPatchResult = applyMediaInternalIdCompatibilityPatch(patched);
  if (mediaInternalIdPatchResult.changed) {
    patched = mediaInternalIdPatchResult.source;
    changed = true;
    patches.push('compatibilidade com identificador interno de mídia');
  }

  if (changed) await writeFile(target, patched, 'utf8');
  return { changed, target, patches };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await patchWhatsappWeb();
  console.log(
    result.changed
      ? `Compatibilidade do WhatsApp aplicada: ${result.patches.join(', ')}.`
      : 'Compatibilidade do WhatsApp já estava aplicada.'
  );
}
