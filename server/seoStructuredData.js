function cleanText(value, maximum = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function validUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function homeUrl(value) {
  const url = validUrl(value);
  return url ? `${url.replace(/\/+$/, '')}/` : '';
}

export function buildWebsiteStructuredData(config = {}, { origin, description } = {}) {
  const url = homeUrl(origin || config.canonicalUrl);
  if (!url) return null;
  const name = cleanText(config.seoSiteName || config.brandName || 'PromoShop', 60);
  const organizationId = `${url}#organization`;
  const websiteId = `${url}#website`;
  const instagramUrl = validUrl(config.instagramUrl);
  const alternateName = name.toLocaleLowerCase('pt-BR') === 'promoshop' ? 'Promo Shop' : undefined;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': websiteId,
        name,
        alternateName,
        url,
        description: cleanText(description || config.seoDescription, 500),
        publisher: { '@id': organizationId }
      },
      {
        '@type': 'Organization',
        '@id': organizationId,
        name: cleanText(config.brandName || name, 60),
        url,
        logo: {
          '@type': 'ImageObject',
          url: `${url}favicon-512.png`,
          width: 512,
          height: 512
        },
        sameAs: instagramUrl ? [instagramUrl] : undefined,
        email: cleanText(config.contactEmail, 200) || undefined
      }
    ]
  };
}

export function latestSeoDate(values = [], fallback = '') {
  const timestamps = values
    .map((value) => {
      const date = new Date(value || '');
      return Number.isNaN(date.getTime()) ? 0 : date.getTime();
    })
    .filter(Boolean);
  if (timestamps.length) return new Date(Math.max(...timestamps)).toISOString().slice(0, 10);
  const fallbackMatch = /^\d{4}-\d{2}-\d{2}/.exec(String(fallback || ''));
  return fallbackMatch?.[0] || new Date().toISOString().slice(0, 10);
}
