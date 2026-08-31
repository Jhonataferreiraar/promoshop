function imageWidthBucket(width) {
  const requested = Number(width) || 450;
  if (requested <= 220) return 200;
  if (requested <= 480) return 450;
  return 640;
}

export function optimizedProductImage(value, width = 450) {
  const source = String(value || '').trim();
  if (!source) return '';

  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    const size = imageWidthBucket(width);

    if ((host === 'shopee.com.br' || host.endsWith('.shopee.com.br')) && url.pathname.startsWith('/file/')) {
      if (!/@resize_w\d+_/i.test(url.pathname)) url.pathname += `@resize_w${size}_nl.webp`;
      return url.toString();
    }

    if (host === 'aliexpress-media.com' || host.endsWith('.aliexpress-media.com')) {
      if (!/_\d+x\d+(?:q\d+)?\.jpg_\.webp$/i.test(url.pathname)) {
        url.pathname += `_${size}x${size}q75.jpg_.webp`;
      }
      return url.toString();
    }
  } catch {
    return source;
  }

  return source;
}
