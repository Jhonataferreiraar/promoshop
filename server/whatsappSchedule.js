const ALLOWED_INTERVAL_MINUTES = new Set([5, 10, 15, 20, 25, 30]);

export function normalizeWhatsappIntervalMinutes(value, fallback = 15) {
  const numeric = Number(value);
  return ALLOWED_INTERVAL_MINUTES.has(numeric) ? numeric : fallback;
}

export function getWhatsappPublicationIntervalState(queue, configuredMinutes, now = Date.now()) {
  const intervalMinutes = normalizeWhatsappIntervalMinutes(configuredMinutes);
  const lastPublicationAt = (Array.isArray(queue) ? queue : [])
    .map((item) => {
      if (item?.status === 'sent' && item?.sentAt) return item.sentAt;

      // Depois que o envio começou, uma resposta perdida do WhatsApp pode
      // marcar o item como falha mesmo que a mensagem já tenha aparecido no
      // destino. Essa tentativa também precisa iniciar o intervalo para não
      // liberar várias ofertas em sequência.
      const deliveryStarted = Array.isArray(item?.deliveryAttemptedDestinationIds)
        && item.deliveryAttemptedDestinationIds.length > 0;
      if (item?.status === 'failed' && deliveryStarted && item?.failedAt) return item.failedAt;
      return null;
    })
    .filter(Boolean)
    .reduce((latest, item) => {
      const publishedAt = new Date(item).getTime();
      return Number.isFinite(publishedAt) ? Math.max(latest, publishedAt) : latest;
    }, 0);
  const elapsedMs = lastPublicationAt ? Math.max(0, Number(now) - lastPublicationAt) : Infinity;
  const remainingMs = lastPublicationAt
    ? Math.max(0, intervalMinutes * 60_000 - elapsedMs)
    : 0;

  return {
    intervalMinutes,
    lastPublicationAt,
    remainingMs,
    elapsed: remainingMs === 0
  };
}

export function getWhatsappRoundIntervalState(queue, configuredMinutes, activeRound, now = Date.now(), completedRound = null) {
  const interval = getWhatsappPublicationIntervalState(queue, configuredMinutes, now);
  const roundInProgress = Boolean(
    activeRound?.id &&
    Array.isArray(activeRound.pendingAudienceCodes) &&
    activeRound.pendingAudienceCodes.length
  );

  // O intervalo configurado separa rodadas completas. Enquanto uma rodada
  // percorre G01, G02, G03 e os demais destinos, o worker mantém somente a
  // pausa curta de segurança entre os envios para concluir a rodada.
  if (roundInProgress) {
    return {
      ...interval,
      remainingMs: 0,
      elapsed: true,
      continuingRound: true
    };
  }

  // A próxima rodada é ancorada no início da rodada anterior. Assim, se a
  // primeira rodada começou às 07:00 e o intervalo é de 15 minutos, a próxima
  // começa às 07:15, mesmo que os últimos destinos da rodada tenham terminado
  // alguns minutos depois. Rodadas antigas sem nextRoundAt usam startedAt.
  const finishedRound = completedRound?.completedAt ? completedRound : null;
  const startedAt = Date.parse(finishedRound?.startedAt || '');
  const explicitNextRoundAt = Date.parse(finishedRound?.nextRoundAt || '');
  const nextRoundAt = Number.isFinite(explicitNextRoundAt)
    ? explicitNextRoundAt
    : Number.isFinite(startedAt)
      ? startedAt + interval.intervalMinutes * 60_000
      : 0;
  if (nextRoundAt) {
    const remainingMs = Math.max(0, nextRoundAt - Number(now));
    return {
      ...interval,
      remainingMs,
      elapsed: remainingMs === 0,
      continuingRound: false,
      anchoredToRound: true,
      nextRoundAt: new Date(nextRoundAt).toISOString()
    };
  }

  return { ...interval, continuingRound: false };
}
