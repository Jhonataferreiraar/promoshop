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
