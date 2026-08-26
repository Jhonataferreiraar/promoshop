export function sanitizeGroupDirectoryCodes(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((code) => String(code || '').trim().toUpperCase())
    .filter((code) => /^G\d{1,3}$/.test(code)))];
}

function cleanLine(value, maximum) {
  return String(value || '').replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, maximum);
}

export function buildGroupDirectoryMessage(options = {}, audiences = []) {
  const includedCodes = sanitizeGroupDirectoryCodes(options.includedCodes);
  const available = (Array.isArray(audiences) ? audiences : [])
    .filter((audience) => audience?.enabled !== false && includedCodes.includes(String(audience?.code || '').toUpperCase()))
    .map((audience) => ({
      code: String(audience.code || '').toUpperCase(),
      name: cleanLine(audience.name || audience.code, 80).replace(/\n/g, ' '),
      link: /^https:\/\//i.test(String(audience.whatsappLink || '').trim()) ? String(audience.whatsappLink).trim().slice(0, 1000) : ''
    }))
    .filter((audience) => audience.link);
  if (!available.length) throw new Error('Selecione pelo menos um grupo que tenha link do WhatsApp configurado.');
  const title = cleanLine(options.title || '📢 Encontre seu grupo PromoShop', 120).replace(/\n/g, ' ');
  const intro = cleanLine(options.intro || 'Escolha os assuntos que você mais gosta e entre nos grupos:', 500);
  const footer = cleanLine(options.footer || '✅ Entre nos seus favoritos e acompanhe as próximas ofertas.', 500);
  const links = available.map((audience) => `• *${audience.name}*\n${audience.link}`).join('\n\n');
  const message = [`*${title.replace(/^\*+|\*+$/g, '')}*`, intro, links, footer].filter(Boolean).join('\n\n').slice(0, 4000);
  return { message, groups: available };
}
