const CAMPAIGN_STATUSES = new Set(['draft', 'scheduled', 'active', 'paused', 'completed']);
const PRICE_MONITOR_STATUSES = new Set(['watching', 'below-target', 'changed', 'unavailable']);

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function uniqueCodes(value, max = 20) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/);
  return [...new Set(list.map((item) => String(item || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)).filter(Boolean))].slice(0, max);
}

function uniqueIds(value, max = 200) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/);
  return [...new Set(list.map((item) => String(item || '').trim().slice(0, 120)).filter((item) => /^[a-zA-Z0-9_-]{1,120}$/.test(item)))].slice(0, max);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() < 0) return null;
  return date.toISOString();
}

export function normalizeCampaign(input = {}, current = {}, now = new Date().toISOString()) {
  const status = CAMPAIGN_STATUSES.has(String(input.status || current.status || 'draft'))
    ? String(input.status || current.status || 'draft')
    : 'draft';
  const scheduledFor = safeDate(input.scheduledFor ?? current.scheduledFor);
  return {
    id: String(input.id || current.id || '').trim().slice(0, 120),
    name: cleanText(input.name ?? current.name, 120),
    description: cleanText(input.description ?? current.description, 500),
    status,
    scheduledFor,
    store: cleanText(input.store ?? current.store, 80),
    category: cleanText(input.category ?? current.category, 100),
    minDiscount: Math.max(0, Math.min(99, Number(input.minDiscount ?? current.minDiscount ?? 0) || 0)),
    maxItems: Math.max(1, Math.min(200, Math.trunc(Number(input.maxItems ?? current.maxItems ?? 20) || 20))),
    offerIds: uniqueIds(input.offerIds ?? current.offerIds, 200),
    targetAudienceCodes: uniqueCodes(input.targetAudienceCodes ?? current.targetAudienceCodes, 20),
    createdAt: safeDate(input.createdAt ?? current.createdAt) || now,
    updatedAt: now,
    queuedAt: safeDate(input.queuedAt ?? current.queuedAt),
    completedAt: safeDate(input.completedAt ?? current.completedAt)
  };
}

export function normalizePriceMonitor(input = {}, current = {}, now = new Date().toISOString()) {
  const status = PRICE_MONITOR_STATUSES.has(String(input.status || current.status || 'watching'))
    ? String(input.status || current.status || 'watching')
    : 'watching';
  const targetPrice = Number(input.targetPrice ?? current.targetPrice ?? 0);
  const lastPrice = Number(input.lastPrice ?? current.lastPrice ?? 0);
  return {
    id: String(input.id || current.id || '').trim().slice(0, 120),
    offerId: String(input.offerId ?? current.offerId ?? '').trim().slice(0, 120),
    targetPrice: Number.isFinite(targetPrice) ? Math.max(0.01, Math.min(10_000_000, targetPrice)) : 0.01,
    alertOnDrop: typeof input.alertOnDrop === 'boolean' ? input.alertOnDrop : current.alertOnDrop !== false,
    alertOnTarget: typeof input.alertOnTarget === 'boolean' ? input.alertOnTarget : current.alertOnTarget !== false,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled !== false,
    status,
    lastPrice: Number.isFinite(lastPrice) && lastPrice > 0 ? Math.min(10_000_000, lastPrice) : 0,
    lastCheckedAt: safeDate(input.lastCheckedAt ?? current.lastCheckedAt),
    lastAlertAt: safeDate(input.lastAlertAt ?? current.lastAlertAt),
    history: Array.isArray(input.history ?? current.history)
      ? (input.history ?? current.history).slice(-30).map((entry) => ({
        price: Math.max(0, Math.min(10_000_000, Number(entry?.price || 0))),
        checkedAt: safeDate(entry?.checkedAt) || now
      }))
      : [],
    createdAt: safeDate(input.createdAt ?? current.createdAt) || now,
    updatedAt: now
  };
}

export function campaignMatchesOffer(campaign = {}, offer = {}) {
  if (campaign.store && String(campaign.store) !== String(offer.store || '')) return false;
  if (campaign.category && String(campaign.category) !== String(offer.category || '')) return false;
  if (Number(campaign.minDiscount || 0) > 0) {
    const price = Number(offer.price || 0);
    const original = Number(offer.originalPrice || 0);
    const discount = original > price && price > 0 ? Math.round((1 - price / original) * 100) : 0;
    if (discount < Number(campaign.minDiscount || 0)) return false;
  }
  return true;
}

export function campaignIsDue(campaign = {}, now = Date.now()) {
  if (!campaign.scheduledFor) return true;
  const timestamp = new Date(campaign.scheduledFor).getTime();
  return Number.isFinite(timestamp) && timestamp <= now;
}

export function queueItemIsDue(item = {}, now = Date.now()) {
  if (!item.scheduledFor) return true;
  const timestamp = new Date(item.scheduledFor).getTime();
  return Number.isFinite(timestamp) && timestamp <= now;
}

export function campaignCalendar(campaigns = [], queue = []) {
  const entries = [];
  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    if (!campaign?.scheduledFor) continue;
    entries.push({
      id: `campaign:${campaign.id}`,
      type: 'campaign',
      title: campaign.name,
      status: campaign.status,
      scheduledFor: campaign.scheduledFor,
      count: Array.isArray(campaign.offerIds) ? campaign.offerIds.length : 0,
      campaignId: campaign.id
    });
  }
  for (const item of Array.isArray(queue) ? queue : []) {
    if (!item?.scheduledFor) continue;
    entries.push({
      id: `queue:${item.id}`,
      type: 'publication',
      title: item.offerTitle || 'Publicação',
      status: item.status || 'pending',
      scheduledFor: item.scheduledFor,
      count: 1,
      campaignId: item.campaignId || null
    });
  }
  return entries.sort((a, b) => new Date(a.scheduledFor || 0) - new Date(b.scheduledFor || 0)).slice(0, 500);
}

export function campaignStatusSet() {
  return new Set(CAMPAIGN_STATUSES);
}
