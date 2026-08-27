const ALLOWED_INTERVAL_MINUTES = new Set([5, 10, 15, 20, 25, 30]);

export function normalizeWhatsappIntervalMinutes(value, fallback = 15) {
  const numeric = Number(value);
  return ALLOWED_INTERVAL_MINUTES.has(numeric) ? numeric : fallback;
}

export function getWhatsappPublicationIntervalState(queue, configuredMinutes, now = Date.now()) {
  const intervalMinutes = normalizeWhatsappIntervalMinutes(configuredMinutes);
  const lastSentAt = (Array.isArray(queue) ? queue : [])
    .filter((item) => item?.status === 'sent' && item?.sentAt)
    .reduce((latest, item) => {
      const sentAt = new Date(item.sentAt).getTime();
      return Number.isFinite(sentAt) ? Math.max(latest, sentAt) : latest;
    }, 0);
  const elapsedMs = lastSentAt ? Math.max(0, Number(now) - lastSentAt) : Infinity;
  const remainingMs = lastSentAt
    ? Math.max(0, intervalMinutes * 60_000 - elapsedMs)
    : 0;

  return {
    intervalMinutes,
    lastSentAt,
    remainingMs,
    elapsed: remainingMs === 0
  };
}
