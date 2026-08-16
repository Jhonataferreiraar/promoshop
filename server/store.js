import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const dataFile = path.join(dataDir, 'db.json');

const initialData = {
  config: {
    brandName: 'PromoShop',
    heroTitle: 'Ofertas boas não esperam.',
    heroText: 'Promoções selecionadas e verificadas para você economizar sem perder tempo.',
    primaryColor: '#1269f3',
    whatsappUrl: '#',
    disclosure: 'Podemos receber comissão pelas compras, sem custo adicional para você.',
    minDiscount: 20,
    maxPostsPerDay: 10,
    quietStart: '22:00',
    quietEnd: '08:00',
    publishingStart: '08:00',
    publishingEnd: '23:00',
    collectionIntervalMinutes: 15,
    mercadoLivreQueries: 'smartphone, fone bluetooth, notebook, casa e decoração',
    shopeeQueries: 'eletrônicos, casa, beleza, moda, ferramentas',
    aliexpressQueries: 'eletrônicos, ferramentas, casa, acessórios',
    aliexpressTrackingId: 'promoshop',
    whatsappGroupId: '',
    whatsappGroupName: '',
    whatsappGroups: [],
    whatsappMaxPerHour: 10,
    whatsappIntervalMinutes: 15,
    whatsappMinDelaySeconds: 12,
    whatsappMaxDelaySeconds: 30,
    whatsappHeadless: true,
    whatsappAutoStart: true,
    aiEnabled: true,
    aiProvider: 'groq',
    aiModel: 'openai/gpt-oss-20b',
    aiBaseUrl: 'https://api.groq.com/openai/v1',
    aiOllamaUrl: 'http://127.0.0.1:11434',
    aiTone: 'varied',
    aiInstructions: 'Destaque o principal benefício do produto, seja convincente sem exagerar e use uma chamada para ação curta.',
    enableMercadoLivre: true,
    enableShopee: false,
    enableAliexpress: false,
    autoQueue: false,
    messageTemplate: '🔥 *{title}*\n\n✨ {benefit}\n\nDe: ~{originalPrice}~\nPor: *{price}* 🔥\n💸 {discount}% OFF\n\n{shipping}\n\n👉 Confira a oferta:\n🛒 {link}\n\n⚠️ Preço, promoção e estoque podem mudar a qualquer momento.'
  },
  offers: [],
  queue: [],
  logs: [],
  meta: { lastCollectionAt: null, whatsapp: { status: 'offline', lastSeenAt: null, qrDataUrl: null, pairingCode: null, groups: [], message: 'Publicador ainda não iniciado.' } }
};

let writeChain = Promise.resolve();

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try { await fs.access(dataFile); }
  catch { await fs.writeFile(dataFile, JSON.stringify(initialData, null, 2), 'utf8'); }
}

export async function readStore() {
  await ensureStore();
  let data;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      data = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  if (!data) throw lastError;
  data.config = { ...initialData.config, ...(data.config || {}) };
  data.meta = { ...initialData.meta, ...(data.meta || {}), whatsapp: { ...initialData.meta.whatsapp, ...(data.meta?.whatsapp || {}) } };
  data.offers ||= [];
  data.queue ||= [];
  data.logs ||= [];
  return data;
}

export async function updateStore(mutator) {
  writeChain = writeChain.catch(() => {}).then(async () => {
    const data = await readStore();
    const result = await mutator(data);
    const temporaryFile = path.join(dataDir, `db-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(temporaryFile, JSON.stringify(data, null, 2), 'utf8');
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temporaryFile, dataFile);
          break;
        } catch (error) {
          if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
        }
      }
    } catch (error) {
      await fs.unlink(temporaryFile).catch(() => {});
      throw error;
    }
    return result;
  });
  return writeChain;
}

export function createId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export async function addLog(message, level = 'info') {
  return updateStore((data) => {
    data.logs.unshift({ id: createId('log'), message, level, createdAt: new Date().toISOString() });
    data.logs = data.logs.slice(0, 200);
  });
}
