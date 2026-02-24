import type { VercelRequest } from '@vercel/node';

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }

    if (Array.isArray(value) && value.length > 0 && value[0]?.trim()) {
        return value[0].trim();
    }

    return null;
}

export function getRequestUrl(req: VercelRequest): URL {
    const rawHost = normalizeHeaderValue(req.headers['x-forwarded-host']) ||
        normalizeHeaderValue(req.headers.host) ||
        'localhost';
    const host = rawHost.split(',')[0].trim();

    const rawProto = normalizeHeaderValue(req.headers['x-forwarded-proto']) || 'https';
    const proto = rawProto.split(',')[0].trim();

    const path = typeof req.url === 'string' && req.url.length > 0 ? req.url : '/';

    return new URL(path, `${proto}://${host}`);
}

export function getRequestSearchParams(req: VercelRequest): URLSearchParams {
    return getRequestUrl(req).searchParams;
}
