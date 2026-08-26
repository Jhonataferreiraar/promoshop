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
  return { kind, id, links: [...new Set(links)], title, store };
}

export function queueItemSourceMatches(left, right) {
  const a = sourceData(left);
  const b = sourceData(right);
  if (a.kind === DIRECTORY_KIND || b.kind === DIRECTORY_KIND || a.kind !== b.kind) return false;
  if (a.id && b.id && a.id === b.id) return true;
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
