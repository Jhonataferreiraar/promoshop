import { addLog } from './store.js';
import { readSecrets } from './secrets.js';
import { readTextLimited } from './httpBody.js';

const CREATE_LINK_URL =
    'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink';

function normalizeProductUrl(url) {
    try {
        const parsed = new URL(url);

        parsed.hash = '';

        const removableParams = [
            'polycard_client',
            'be_origin',
            'overlay_label',
            'search_layout',
            'position',
            'type',
            'tracking_id',
            'wid',
            'sid'
        ];

        for (const param of removableParams) {
            parsed.searchParams.delete(param);
        }

        return parsed.toString();
    } catch {
        return String(url || '').trim();
    }
}

export async function generateMercadoLivreAffiliateLinks(
    productUrls,
    options = {}
) {
    const log = typeof options.log === 'function' ? options.log : addLog;
    const urls = [...new Set(
        productUrls
            .map(normalizeProductUrl)
            .filter(Boolean)
    )];

    if (!urls.length) {
        return new Map();
    }

    const secrets = await readSecrets();

    const cookie =
        secrets.mercadoLivreAffiliateCookie ||
        process.env.MERCADO_LIVRE_AFFILIATE_COOKIE;

    const csrfToken =
        secrets.mercadoLivreAffiliateCsrfToken ||
        process.env.MERCADO_LIVRE_AFFILIATE_CSRF_TOKEN;

    const tag =
        options.tag ||
        secrets.mercadoLivreAffiliateTag ||
        process.env.MERCADO_LIVRE_AFFILIATE_TAG ||
        'promoshop';

    if (!cookie || !csrfToken) {
        await log(
            'Mercado Livre Afiliados: sessão automática não configurada. Mantendo vinculação manual.',
            'info'
        );

        return new Map();
    }

    try {
        const response = await fetch(CREATE_LINK_URL, {
            method: 'POST',
            signal: AbortSignal.timeout(20_000),

            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Cookie: cookie,
                Origin: 'https://www.mercadolivre.com.br',
                Referer: 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
                'x-csrf-token': csrfToken
            },

            body: JSON.stringify({
                urls,
                tag
            })
        });

        const raw = await readTextLimited(response);

        let payload;

        try {
            payload = raw ? JSON.parse(raw) : {};
        } catch {
            payload = {};
        }

        const contentType = response.headers.get('content-type') || '';

        if (!response.ok || !contentType.includes('application/json')) {
            throw new Error(
                `HTTP ${response.status} | ` +
                `content-type: ${contentType || 'desconhecido'} | ` +
                `URL final: ${response.url} | ` +
                `resposta: ${raw.slice(0, 220).replace(/\s+/g, ' ')}`
            );
        }

        const links = new Map();

        for (const item of payload.urls || []) {
            const originUrl = normalizeProductUrl(item.origin_url);

            if (!originUrl || !item.short_url) {
                continue;
            }

            links.set(originUrl, item.short_url);
        }

        await log(
            `Mercado Livre Afiliados: ${links.size} link(s) automático(s) gerado(s).`,
            links.size ? 'success' : 'info'
        );

        return links;
    } catch (error) {
        await log(
            `Mercado Livre Afiliados: geração automática indisponível (${error.message}). As ofertas permanecerão disponíveis para vinculação manual.`,
            'error'
        );

        return new Map();
    }
}

export function normalizeMercadoLivreAffiliateUrl(url) {
    return normalizeProductUrl(url);
}
