function serializedDestinationId(destination) {
  return String(destination?.id || '').trim();
}

export function uniqueWhatsAppDestinations(destinations) {
  const seen = new Set();

  return (Array.isArray(destinations) ? destinations : []).filter((destination) => {
    const id = serializedDestinationId(destination);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function shouldMentionEveryone({ enabled, item, destination }) {
  return enabled === true
    && item?.kind === 'group-directory'
    && serializedDestinationId(destination).endsWith('@g.us');
}
