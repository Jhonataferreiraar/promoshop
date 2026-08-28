const COLOR = /^#[0-9a-f]{6}$/i;

export const DEFAULT_INSTAGRAM_THEMES = [
  { id: 'default', name: 'PromoShop', enabled: true, automatic: true, start: '01-01', end: '12-31', priority: 0, background: '#1269f3', background2: '#0848b8', accent: '#ffd84d', text: '#ffffff', decoration: 'spark' },
  { id: 'carnival', name: 'Carnaval', enabled: true, automatic: true, start: '02-01', end: '03-10', priority: 20, background: '#6d28d9', background2: '#db2777', accent: '#fde047', text: '#ffffff', decoration: 'confetti' },
  { id: 'easter', name: 'Páscoa', enabled: true, automatic: true, start: '03-15', end: '04-20', priority: 20, background: '#7c3aed', background2: '#4c1d95', accent: '#fde68a', text: '#ffffff', decoration: 'dots' },
  { id: 'mothers', name: 'Dia das Mães', enabled: true, automatic: true, start: '05-01', end: '05-15', priority: 25, background: '#be185d', background2: '#831843', accent: '#fbcfe8', text: '#ffffff', decoration: 'hearts' },
  { id: 'valentine', name: 'Dia dos Namorados', enabled: true, automatic: true, start: '06-01', end: '06-12', priority: 25, background: '#dc2626', background2: '#881337', accent: '#fda4af', text: '#ffffff', decoration: 'hearts' },
  { id: 'june', name: 'Festa Junina', enabled: true, automatic: true, start: '06-13', end: '07-10', priority: 20, background: '#c2410c', background2: '#7c2d12', accent: '#fde047', text: '#ffffff', decoration: 'flags' },
  { id: 'fathers', name: 'Dia dos Pais', enabled: true, automatic: true, start: '08-01', end: '08-15', priority: 25, background: '#172554', background2: '#0f172a', accent: '#fbbf24', text: '#ffffff', decoration: 'lines' },
  { id: 'independence', name: 'Independência do Brasil', enabled: true, automatic: true, start: '09-01', end: '09-08', priority: 35, background: '#009c3b', background2: '#006b2c', accent: '#ffdf00', text: '#ffffff', decoration: 'independence' },
  { id: 'consumer', name: 'Semana do Consumidor', enabled: true, automatic: true, start: '03-08', end: '03-18', priority: 30, background: '#1269f3', background2: '#1d4ed8', accent: '#fde047', text: '#ffffff', decoration: 'tags' },
  { id: 'black-friday', name: 'Black Friday', enabled: true, automatic: true, start: '11-15', end: '11-30', priority: 40, background: '#09090b', background2: '#18181b', accent: '#facc15', text: '#ffffff', decoration: 'lightning' },
  { id: 'christmas', name: 'Natal', enabled: true, automatic: true, start: '12-01', end: '12-26', priority: 30, background: '#b91c1c', background2: '#14532d', accent: '#fbbf24', text: '#ffffff', decoration: 'snow' },
  { id: 'new-year', name: 'Ano-Novo', enabled: true, automatic: true, start: '12-27', end: '01-07', priority: 35, background: '#0f172a', background2: '#1e3a8a', accent: '#fbbf24', text: '#ffffff', decoration: 'fireworks' }
];

function cleanDate(value, fallback) {
  return /^\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : fallback;
}

function cleanColor(value, fallback) {
  return COLOR.test(String(value || '')) ? String(value).toLowerCase() : fallback;
}

export function sanitizeInstagramThemes(value) {
  const storedThemes = Array.isArray(value) && value.length ? value : [];
  // Built-in campaigns are added to older configurations automatically. This
  // keeps new seasonal templates available without overwriting custom themes.
  const source = storedThemes.length
    ? [...storedThemes, ...DEFAULT_INSTAGRAM_THEMES.filter((theme) => !storedThemes.some((entry) => String(entry?.id || '') === theme.id))]
    : DEFAULT_INSTAGRAM_THEMES;
  const seen = new Set();

  return source.slice(0, 24).map((theme, index) => {
    const defaults = DEFAULT_INSTAGRAM_THEMES.find((entry) => entry.id === theme?.id) || DEFAULT_INSTAGRAM_THEMES[0];
    let id = String(theme?.id || `theme-${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `theme-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);

    return {
      id,
      name: String(theme?.name || defaults.name || 'Tema').trim().slice(0, 60),
      enabled: theme?.enabled !== false,
      automatic: theme?.automatic !== false,
      start: cleanDate(theme?.start, defaults.start),
      end: cleanDate(theme?.end, defaults.end),
      priority: Math.max(0, Math.min(100, Number(theme?.priority ?? defaults.priority) || 0)),
      background: cleanColor(theme?.background, defaults.background),
      background2: cleanColor(theme?.background2, defaults.background2),
      accent: cleanColor(theme?.accent, defaults.accent),
      text: cleanColor(theme?.text, defaults.text),
      decoration: String(theme?.decoration || defaults.decoration || 'spark').replace(/[^a-z-]/g, '').slice(0, 30)
    };
  });
}

function inAnnualRange(monthDay, start, end) {
  return start <= end
    ? monthDay >= start && monthDay <= end
    : monthDay >= start || monthDay <= end;
}

export function selectInstagramTheme(config = {}, date = new Date(), requestedId = '') {
  const themes = sanitizeInstagramThemes(config.instagramThemes);
  if (requestedId) {
    return themes.find((theme) => theme.id === requestedId) || themes[0];
  }

  if (config.instagramThemeMode === 'manual' && config.instagramManualThemeId) {
    return themes.find((theme) => theme.enabled && theme.id === config.instagramManualThemeId) || themes[0];
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const monthDay = `${values.month}-${values.day}`;
  return themes
    .filter((theme) => theme.enabled && theme.automatic && theme.id !== 'default' && inAnnualRange(monthDay, theme.start, theme.end))
    .sort((a, b) => b.priority - a.priority)[0]
    || themes.find((theme) => theme.id === 'default' && theme.enabled)
    || themes.find((theme) => theme.enabled)
    || DEFAULT_INSTAGRAM_THEMES[0];
}
