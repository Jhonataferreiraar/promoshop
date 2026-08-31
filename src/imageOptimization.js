export function optimizedProductImage(value, width = 450) {
  const source = String(value || '').trim();
  if (!source) return '';

  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    const requested = Number(width) || 350;

    if ((host === 'shopee.com.br' || host.endsWith('.shopee.com.br')) && url.pathname.startsWith('/file/')) {
      const size = requested <= 220 ? 200 : requested <= 480 ? 320 : 640;
      if (!/@resize_w\d+_/i.test(url.pathname)) url.pathname += `@resize_w${size}_nl.webp`;
      return url.toString();
    }

    if (host === 'aliexpress-media.com' || host.endsWith('.aliexpress-media.com')) {
      const size = requested <= 220 ? 220 : requested <= 480 ? 350 : 640;
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

export function optimizedProductImageSrcSet(value) {
  const source = String(value || '').trim();
  if (!source) return undefined;
  try {
    const host = new URL(source).hostname.toLowerCase();
    if (host === 'shopee.com.br' || host.endsWith('.shopee.com.br')) {
      return `${optimizedProductImage(source, 200)} 200w, ${optimizedProductImage(source, 350)} 320w`;
    }
    if (host === 'aliexpress-media.com' || host.endsWith('.aliexpress-media.com')) {
      return `${optimizedProductImage(source, 220)} 220w, ${optimizedProductImage(source, 350)} 350w`;
    }
  } catch { }
  return undefined;
}
