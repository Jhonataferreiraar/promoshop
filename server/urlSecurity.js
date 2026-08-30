export function safeRedirectDestination(origin, requestPath) {
  try {
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol)) return '';
    const rawPath = String(requestPath || '/');
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\r') || rawPath.includes('\n')) return '';
    const destination = new URL(rawPath, base);
    return destination.origin === base.origin ? destination.href : '';
  } catch {
    return '';
  }
}
