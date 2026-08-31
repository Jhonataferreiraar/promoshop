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

export function normalizeGtin(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return '';
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = body.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(body[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1)) ? digits : '';
}

function gtinSchema(value) {
  const gtin = normalizeGtin(value);
  return gtin ? { [`gtin${gtin.length}`]: gtin } : {};
}

export function buildProductStructuredData(offer, { canonical, description } = {}) {
  const price = Number(offer?.price || 0);
  if (!offer?.title || !(price > 0)) return null;

  const brand = cleanText(offer.brand, 70);
  const mpn = cleanText(offer.mpn, 70);
  const sku = cleanText(offer.externalId || offer.id, 100).replace(/\s+/g, '-');
  const ratingValue = Number(offer.rating || 0);
  const ratingCount = Math.floor(Number(offer.ratingCount || offer.reviewCount || 0));
  const aggregateRating = ratingValue >= 1 && ratingValue <= 5 && ratingCount > 0
    ? { '@type': 'AggregateRating', ratingValue, ratingCount, bestRating: 5, worstRating: 1 }
    : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: cleanText(offer.title, 300),
    image: validUrl(offer.image) ? [validUrl(offer.image)] : undefined,
    description: cleanText(description, 500),
    category: cleanText(offer.category, 100) || undefined,
    sku: sku || undefined,
    brand: brand ? { '@type': 'Brand', name: brand } : undefined,
    mpn: mpn || undefined,
    ...gtinSchema(offer.gtin || offer.ean || offer.upc),
    aggregateRating,
    // O PromoShop compara e encaminha ofertas de terceiros; não vende, envia
    // nem recebe devoluções. AggregateOffer mantém o snippet de preço sem
    // declarar o PromoShop como o comerciante responsável pela transação.
    offers: {
      '@type': 'AggregateOffer',
      url: validUrl(canonical) || undefined,
      priceCurrency: 'BRL',
      lowPrice: price.toFixed(2),
      highPrice: price.toFixed(2),
      offerCount: 1
    }
  };
}
