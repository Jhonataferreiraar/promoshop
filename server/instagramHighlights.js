export const INSTAGRAM_HIGHLIGHT_ICONS = ['bolt', 'ticket', 'users', 'info', 'store', 'message', 'star', 'heart'];

export const DEFAULT_INSTAGRAM_HIGHLIGHTS = [
  { id: 'offers', name: 'Ofertas', icon: 'bolt', description: 'Achados e promoções selecionadas todos os dias.', enabled: true },
  { id: 'coupons', name: 'Cupons', icon: 'ticket', description: 'Cupons ativos para você economizar ainda mais.', enabled: true },
  { id: 'groups', name: 'Grupos', icon: 'users', description: 'Entre nos grupos da PromoShop e receba as oportunidades.', enabled: true },
  { id: 'stores', name: 'Lojas', icon: 'store', description: 'Ofertas das melhores lojas reunidas em um só lugar.', enabled: true },
  { id: 'how-it-works', name: 'Como funciona', icon: 'info', description: 'Veja como encontrar, conferir e aproveitar cada oferta.', enabled: true },
  { id: 'contact', name: 'Contato', icon: 'message', description: 'Fale com a PromoShop e tire suas dúvidas.', enabled: true }
];

function cleanText(value, maximum) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

export function sanitizeInstagramHighlights(value) {
  const source = Array.isArray(value) ? value : DEFAULT_INSTAGRAM_HIGHLIGHTS;
  const ids = new Set();
  return source.slice(0, 20).map((entry, index) => {
    const rawId = cleanText(entry?.id, 60).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    let id = rawId || `highlight-${index + 1}`;
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    const icon = INSTAGRAM_HIGHLIGHT_ICONS.includes(String(entry?.icon)) ? String(entry.icon) : 'star';
    return {
      id,
      name: cleanText(entry?.name, 30) || `Destaque ${index + 1}`,
      icon,
      description: cleanText(entry?.description, 180),
      enabled: entry?.enabled !== false
    };
  });
}
