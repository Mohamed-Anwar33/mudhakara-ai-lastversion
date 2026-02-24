import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getRequestSearchParams } from './_lib/request-url.js';

/**
 * Vercel API Route: /api/search
 * 
 * Hybrid search endpoint: query → embedding → hybrid_search_rrf
 * 
 * GET /api/search?lessonId=xxx&q=search+text&topK=5
 * 
 * Flow:
 * 1. Receive query text + lessonId
 * 2. Compute query embedding via text-embedding-3-small
 * 3. Call hybrid_search_rrf RPC
 * 4. Return ranked results
 */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

async function getQueryEmbedding(queryText: string): Promise<number[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY must be set');
    }

    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: queryText
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Embedding API error (${response.status}): ${error}`);
    }

    const result = await response.json();
    return result.data[0].embedding;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const searchParams = getRequestSearchParams(req);
        const lessonId = searchParams.get('lessonId');
        const q = searchParams.get('q');
        const topK = searchParams.get('topK');

        if (!lessonId) {
            return res.status(400).json({ error: 'lessonId مطلوب' });
        }

        if (!q || q.trim().length === 0) {
            return res.status(400).json({ error: 'q (نص البحث) مطلوب' });
        }

        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);
        const parsedTopK = topK ? parseInt(topK, 10) : NaN;
        const limit = Math.min(Number.isFinite(parsedTopK) ? parsedTopK : 5, 20);

        // ==========================================
        // 1. Compute query embedding
        // ==========================================
        const queryEmbedding = await getQueryEmbedding(q.trim());

        // ==========================================
        // 2. Call hybrid_search_rrf
        // ==========================================
        const { data, error } = await supabase.rpc('hybrid_search_rrf', {
            p_lesson_id: lessonId,
            p_query_text: q.trim(),
            p_query_embedding: JSON.stringify(queryEmbedding),
            p_top_k: limit,
            p_rrf_k: 60
        });

        if (error) {
            throw new Error(`Search error: ${error.message}`);
        }

        return res.status(200).json({
            query: q.trim(),
            lessonId,
            results: data || [],
            count: data?.length || 0
        });

    } catch (error: any) {
        console.error('Search Error:', error);
        return res.status(500).json({
            error: error.message || 'حدث خطأ أثناء البحث'
        });
    }
}
