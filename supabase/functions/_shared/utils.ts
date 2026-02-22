export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

export function errorResponse(message: string, status = 500) {
    return jsonResponse({ error: message }, status);
}

import { encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts';

/** Base64 encode for Deno (no Buffer) */
export function toBase64(buffer: ArrayBuffer): string {
    return encode(new Uint8Array(buffer));
}
