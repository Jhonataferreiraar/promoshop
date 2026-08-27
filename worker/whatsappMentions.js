const DEFAULT_MENTION_LABEL = '@todos';
const MAX_COMPATIBILITY_MENTIONS = 300;

function serializeId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value._serialized === 'string') return value._serialized.trim();
  if (typeof value.serialized === 'string') return value.serialized.trim();
  if (typeof value.id === 'string') return value.id.trim();
  if (value.user && value.server) return `${value.user}@${value.server}`;
  if (value.id) return serializeId(value.id);
  return '';
}

export function participantId(participant) {
  return serializeId(participant?.id ?? participant);
}

export function uniqueParticipantIds(participants, { exclude = [] } = {}) {
  const excluded = new Set(
    exclude.map((value) => serializeId(value)).filter(Boolean)
  );
  const seen = new Set();

  return (Array.isArray(participants) ? participants : [])
    .map(participantId)
    .filter((id) => id && !excluded.has(id) && !seen.has(id) && seen.add(id));
}

export function buildMentionAllPayload(message, participantIds = []) {
  const ids = uniqueParticipantIds(participantIds);
  const compatibilityIds = ids.length <= MAX_COMPATIBILITY_MENTIONS ? ids : [];

  return {
    // WhatsApp's current Web client interprets this marker together with
    // nonJidMentions as the compact native "mention everyone" action.
    message: `${DEFAULT_MENTION_LABEL}\n\n${String(message || '')}`,
    options: {
      // The native marker handles large groups. The individual IDs are kept
      // only as a compatibility fallback for normal-sized groups because
      // WhatsApp Web may reject very large mentionedJidList payloads.
      ...(compatibilityIds.length ? { mentions: compatibilityIds } : {}),
      // `mentionAll` is used by newer Web clients; `nonJidMentions` is the
      // serialized message field used by the current WhatsApp protocol.
      extra: { mentionAll: true, nonJidMentions: 1 }
    },
    participantCount: ids.length
  };
}

export function buildParticipantMentionFallback(message, participantIds = []) {
  const ids = uniqueParticipantIds(participantIds);
  if (!ids.length) {
    return {
      message: `${DEFAULT_MENTION_LABEL}\n\n${String(message || '')}`,
      options: {},
      participantCount: 0
    };
  }

  const tokens = ids
    .map((id) => `@${id.split('@')[0]}`)
    .join(' ');

  return {
    message: `${tokens}\n\n${String(message || '')}`,
    options: { mentions: ids },
    participantCount: ids.length
  };
}
