import crypto from 'node:crypto';

const OFFER_KIND = 'offer';
const COUPON_KIND = 'coupon';
const DIRECTORY_KIND = 'group-directory';

function clean(value) {
  return String(value || '').trim();
}

function normalizeTitle(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLink(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    // Parâmetros de rastreamento mudam a URL sem mudar o produto.
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|aff|affiliate|tracking|ref|sub|tag|campaign)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    const query = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`.replace(/\/$/, '');
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

function kindOf(item) {
  if (item?.kind === COUPON_KIND) return COUPON_KIND;
  if (item?.kind === DIRECTORY_KIND) return DIRECTORY_KIND;
  return OFFER_KIND;
}

function sourceData(item) {
  const kind = kindOf(item);
  const snapshot = item?.couponSnapshot || item?.offerSnapshot || {};
  const id = clean(
    kind === COUPON_KIND
      ? item?.couponId || snapshot.id
      : item?.offerId || snapshot.id || (!item?.offerSnapshot && !item?.couponSnapshot ? item?.id : '')
  );
  const links = [
    item?.link,
    item?.affiliateUrl,
    item?.productUrl,
    snapshot.link,
    snapshot.affiliateUrl,
    snapshot.productUrl,
    snapshot.shortUrl
  ].map(normalizeLink).filter(Boolean);
  const title = normalizeTitle(item?.offerTitle || item?.title || snapshot.title);
  const store = normalizeTitle(item?.store || snapshot.store);
  const externalId = clean(item?.externalId || item?.productId || snapshot.externalId || snapshot.productId);
  const source = normalizeTitle(item?.source || snapshot.source);
  return { kind, id, externalId, source, links: [...new Set(links)], title, store };
}

function sourceBucketKeys(item) {
  const source = sourceData(item);
  if (source.kind === DIRECTORY_KIND) return [];
  const keys = [];
  if (source.id) keys.push(`${source.kind}:id:${source.id}`);
  if (source.externalId) keys.push(`${source.kind}:external:${source.externalId}`);
  for (const link of source.links) keys.push(`${source.kind}:link:${link}`);
  if (source.title) keys.push(`${source.kind}:title:${source.title}`);
  return keys;
}

export function queueSourceLedgerKeys(item) {
  return sourceBucketKeys(item).map((key) => crypto.createHash('sha256').update(key).digest('base64url'));
}

export function recordSentSourceInLedger(data, item) {
  const keys = queueSourceLedgerKeys(item);
  if (!keys.length) return;
  data.meta ||= {};
  data.meta.whatsappSentSourceLedger = data.meta.whatsappSentSourceLedger && typeof data.meta.whatsappSentSourceLedger === 'object'
    ? data.meta.whatsappSentSourceLedger
    : {};
  const sentAt = item?.sentAt || new Date().toISOString();
  for (const key of keys) data.meta.whatsappSentSourceLedger[key] = sentAt;
}

export function hasSentSourceInLedger(data, candidate) {
  const ledger = data?.meta?.whatsappSentSourceLedger;
  if (!ledger || typeof ledger !== 'object') return false;
  return queueSourceLedgerKeys(candidate).some((key) => Object.hasOwn(ledger, key));
}

export function createQueueSourceIndex(queue, predicate = () => true) {
  const buckets = new Map();
  for (const item of Array.isArray(queue) ? queue : []) {
    if (!predicate(item)) continue;
    for (const key of sourceBucketKeys(item)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
  }
  return {
    matchingItems(candidate) {
      const matches = [];
      const seen = new Set();
      for (const key of sourceBucketKeys(candidate)) {
        for (const item of buckets.get(key) || []) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (queueItemSourceMatches(item, candidate)) matches.push(item);
        }
      }
      return matches;
    }
  };
}

export function queueItemSourceMatches(left, right) {
  const a = sourceData(left);
  const b = sourceData(right);
  if (a.kind === DIRECTORY_KIND || b.kind === DIRECTORY_KIND || a.kind !== b.kind) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (
    a.externalId && b.externalId && a.externalId === b.externalId &&
    ((!a.store || !b.store || a.store === b.store) || (a.source && b.source && a.source === b.source))
  ) return true;
  if (a.links.some((link) => b.links.includes(link))) return true;
  return Boolean(a.title && b.title && a.title === b.title && (!a.store || !b.store || a.store === b.store));
}

/**
 * Correspondência conservadora para operações administrativas de limpeza.
 *
 * A regra usada pelo publicador também aceita título + loja como fallback,
 * porque isso ajuda a impedir repetições quando uma fonte não fornece um ID.
 * Para uma limpeza irreversível de itens da fila, entretanto, não usamos esse
 * fallback: só consideramos duplicata quando existe um identificador ou link
 * de origem compartilhado. Assim, variações legítimas com o mesmo título não
 * são removidas por engano.
 */
export function queueItemStrongSourceMatches(left, right) {
  const a = sourceData(left);
  const b = sourceData(right);
  if (a.kind === DIRECTORY_KIND || b.kind === DIRECTORY_KIND || a.kind !== b.kind) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (
    a.externalId && b.externalId && a.externalId === b.externalId &&
    ((!a.store || !b.store || a.store === b.store) || (a.source && b.source && a.source === b.source))
  ) return true;
  return a.links.some((link) => b.links.includes(link));
}

function cleanupItemOrder(item) {
  const createdAt = new Date(item?.createdAt || 0).getTime();
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
}

function cleanupItemComparator(left, right) {
  const timeDifference = cleanupItemOrder(left) - cleanupItemOrder(right);
  if (timeDifference !== 0) return timeDifference;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

/**
 * Planeja a remoção segura de cópias pendentes da fila.
 *
 * O plano não altera o armazenamento. Itens `publishing` são sempre
 * preservados; entre itens `pending`, a cópia mais antiga é a canônica. O
 * filtro de loja é opcional e serve para permitir uma manutenção isolada do
 * Mercado Livre sem tocar nas demais fontes.
 */
export function planPendingDuplicateCleanup(queue, { store = '' } = {}) {
  const expectedStore = normalizeTitle(store);
  const scopedItems = (Array.isArray(queue) ? queue : []).filter((item) => {
    if (kindOf(item) !== OFFER_KIND || !['pending', 'publishing'].includes(item?.status)) return false;
    if (!expectedStore) return true;
    return sourceData(item).store === expectedStore;
  });
  const pendingItems = scopedItems.filter((item) => item?.status === 'pending');
  const publishingItems = scopedItems.filter((item) => item?.status === 'publishing');
  const sourceIndex = createQueueSourceIndex(scopedItems, () => true);
  const duplicateIds = new Set();
  const groups = new Map();

  for (const candidate of pendingItems) {
    const matches = sourceIndex
      .matchingItems(candidate)
      .filter((item) => queueItemStrongSourceMatches(item, candidate));
    if (matches.length < 2) continue;

    const publishing = matches
      .filter((item) => item?.status === 'publishing')
      .sort(cleanupItemComparator)[0];
    const canonical = publishing || matches
      .filter((item) => item?.status === 'pending')
      .sort(cleanupItemComparator)[0];
    if (!canonical) continue;

    if (candidate.id === canonical.id) continue;
    const group = groups.get(canonical.id) || {
      canonicalId: canonical.id,
      title: String(canonical.offerTitle || canonical.offerSnapshot?.title || '').trim(),
      duplicateIds: new Set()
    };
    group.duplicateIds.add(candidate.id);
    groups.set(canonical.id, group);
    duplicateIds.add(candidate.id);
  }

  return {
    store: expectedStore,
    pendingCount: pendingItems.length,
    publishingCount: publishingItems.length,
    duplicateIds: [...duplicateIds],
    duplicateCount: duplicateIds.size,
    groupCount: groups.size,
    groups: [...groups.values()]
      .map((group) => ({
        canonicalId: group.canonicalId,
        title: group.title,
        duplicateCount: group.duplicateIds.size
      }))
      .sort((left, right) => left.title.localeCompare(right.title, 'pt-BR'))
  };
}

function itemTargetsAudience(item, audienceCode) {
  const code = clean(audienceCode).toUpperCase();
  if (!code) return false;
  if (clean(item?.roundAudienceCode).toUpperCase() === code) return true;
  const codes = Array.isArray(item?.targetAudienceCodes) ? item.targetAudienceCodes : [];
  return codes.some((entry) => clean(entry).toUpperCase() === code);
}

export function wasRecentlySentToAudience(queue, candidate, audienceCode, cooldownHours, now = Date.now()) {
  const hours = Number(cooldownHours);
  if (!Array.isArray(queue) || !candidate || !Number.isFinite(hours) || hours <= 0) return false;
  const cutoff = now - hours * 60 * 60 * 1000;
  return queue.some((item) => {
    if (item?.status !== 'sent' || !item.sentAt || !itemTargetsAudience(item, audienceCode)) return false;
    const sentAt = new Date(item.sentAt).getTime();
    return Number.isFinite(sentAt) && sentAt >= cutoff && queueItemSourceMatches(item, candidate);
  });
}

export function hasPendingSource(queue, candidate) {
  if (!Array.isArray(queue) || !candidate) return false;
  return queue.some((item) => ['pending', 'publishing'].includes(item?.status) && queueItemSourceMatches(item, candidate));
}

/**
 * Uma fonte que já foi confirmada como enviada não deve voltar para a fila.
 * A comparação é intencionalmente independente do grupo: uma oferta é uma
 * única publicação e não deve reaparecer por causa de uma nova URL de
 * afiliado, de uma tentativa manual ou de uma nova rodada.
 */
export function hasSentSource(queue, candidate, sourceIndex = null) {
  if (!Array.isArray(queue) || !candidate) return false;
  if (sourceIndex) return sourceIndex.matchingItems(candidate).some((item) => item?.status === 'sent');
  return queue.some((item) => item?.status === 'sent' && queueItemSourceMatches(item, candidate));
}

/**
 * Evita que duas cópias da mesma fonte sejam reivindicadas enquanto a
 * primeira ainda está sendo preparada ou enviada.
 */
export function hasOtherPendingSource(queue, candidate) {
  if (!Array.isArray(queue) || !candidate) return false;
  return queue.some((item) => (
    item?.id !== candidate?.id &&
    ['pending', 'publishing'].includes(item?.status) &&
    queueItemSourceMatches(item, candidate)
  ));
}

/**
 * Escolhe uma única cópia quando a mesma fonte entrou na fila mais de uma
 * vez. Um item que já está sendo publicado sempre bloqueia os demais; entre
 * itens pendentes, fica válida somente a cópia mais antiga.
 */
export function hasBlockingPendingSource(queue, candidate, sourceIndex = null) {
  if (!Array.isArray(queue) || !candidate) return false;
  const candidateCreatedAt = new Date(candidate.createdAt || 0).getTime();
  const candidateOrder = Number.isFinite(candidateCreatedAt) ? candidateCreatedAt : Number.MAX_SAFE_INTEGER;

  const comparableItems = sourceIndex ? sourceIndex.matchingItems(candidate) : queue;
  return comparableItems.some((item) => {
    if (
      item?.id === candidate?.id ||
      !['pending', 'publishing'].includes(item?.status) ||
      !queueItemSourceMatches(item, candidate)
    ) return false;
    if (item.status === 'publishing') return true;

    const itemCreatedAt = new Date(item.createdAt || 0).getTime();
    const itemOrder = Number.isFinite(itemCreatedAt) ? itemCreatedAt : Number.MAX_SAFE_INTEGER;
    if (itemOrder !== candidateOrder) return itemOrder < candidateOrder;
    return String(item.id || '') < String(candidate.id || '');
  });
}
