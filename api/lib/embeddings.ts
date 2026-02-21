import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Embeddings Module — Phase 4
 * 
 * Generates vector embeddings for document_sections using OpenAI text-embedding-3-small.
 * 
 * Design decisions:
 * ─────────────────
 * Batch size: 32
 *   - text-embedding-3-small supports up to 2048 inputs per request
 *   - Each chunk is ~512 tokens → 32 × 512 = ~16K tokens per batch
 *   - Well within the 8M token/min rate limit (Tier 1: 1M/min)
 *   - Small enough that a single batch failure doesn't waste much work
 *   - Large enough to minimize HTTP overhead
 * 
 * Retry policy:
 *   - Max 5 retries per batch
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s
 *   - ±25% jitter to prevent thundering herd
 *   - Only retry on 429 (rate limit) or 5xx (server error)
 *   - 4xx errors (except 429) are unrecoverable → fail immediately
 * 
 * Idempotency:
 *   - Only selects rows WHERE embedding IS NULL
 *   - Never overwrites existing non-null embeddings
 *   - Safe to re-run after partial failure
 * 
 * Concurrency:
 *   - Job-level isolation via processing_queue's acquire_job (SKIP LOCKED)
 *   - Row-level safety via WHERE embedding IS NULL (no double-write)
 *   - No extra locking needed since one job = one lesson's embeddings
 */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 32;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

// ============================================================================
// TYPES
// ============================================================================

interface UnembeddedSection {
    id: string;
    content: string;
}

interface EmbeddingResult {
    totalSections: number;
    alreadyEmbedded: number;
    newlyEmbedded: number;
    failedBatches: number;
}

interface OpenAIEmbeddingResponse {
    object: string;
    data: Array<{
        object: string;
        index: number;
        embedding: number[];
    }>;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

// ============================================================================
// RETRY LOGIC
// ============================================================================

/**
 * Sleep with jitter.
 * Adds ±25% random variance to prevent thundering herd.
 */
function sleepWithJitter(baseMs: number): Promise<void> {
    const jitter = baseMs * 0.25 * (Math.random() * 2 - 1); // ±25%
    const duration = Math.max(100, baseMs + jitter);
    return new Promise(resolve => setTimeout(resolve, duration));
}

/**
 * Determines if an HTTP error is retryable.
 */
function isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
}

// ============================================================================
// CORE: Call OpenAI Embeddings API
// ============================================================================

/**
 * Calls OpenAI embeddings API with retry logic.
 * Returns an array of embeddings in the same order as input texts.
 */
async function callEmbeddingsAPI(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY must be set for embedding generation');
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(OPENAI_EMBEDDINGS_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: EMBEDDING_MODEL,
                    input: texts
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();

                if (isRetryable(response.status) && attempt < MAX_RETRIES - 1) {
                    const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                    console.warn(
                        `[Embeddings] Retryable error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES}). ` +
                        `Retrying in ${delay}ms...`
                    );
                    await sleepWithJitter(delay);
                    continue;
                }

                throw new Error(
                    `OpenAI Embeddings API error (${response.status}): ${errorBody}`
                );
            }

            const result: OpenAIEmbeddingResponse = await response.json();

            // Validate response structure
            if (!result.data || !Array.isArray(result.data)) {
                throw new Error('Invalid response structure from OpenAI Embeddings API');
            }

            // Sort by index to guarantee order matches input
            const sorted = result.data.sort((a, b) => a.index - b.index);

            // Validate every embedding
            const embeddings: number[][] = [];
            for (const item of sorted) {
                if (!item.embedding || item.embedding.length !== EMBEDDING_DIM) {
                    throw new Error(
                        `Invalid embedding dimension: expected ${EMBEDDING_DIM}, got ${item.embedding?.length || 0}`
                    );
                }

                // Reject zero vectors
                const isZero = item.embedding.every(v => v === 0);
                if (isZero) {
                    throw new Error('Received zero vector from OpenAI — input may be empty or invalid');
                }

                embeddings.push(item.embedding);
            }

            if (embeddings.length !== texts.length) {
                throw new Error(
                    `Embedding count mismatch: sent ${texts.length} texts, got ${embeddings.length} embeddings`
                );
            }

            console.log(
                `[Embeddings] Batch success: ${texts.length} texts, ` +
                `${result.usage.total_tokens} tokens used`
            );

            return embeddings;

        } catch (err: any) {
            lastError = err;
            if (attempt < MAX_RETRIES - 1 && err.message?.includes('fetch')) {
                // Network error — retry
                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                console.warn(`[Embeddings] Network error, retrying in ${delay}ms...`);
                await sleepWithJitter(delay);
                continue;
            }
        }
    }

    throw lastError || new Error('Embedding generation failed after all retries');
}

// ============================================================================
// ORCHESTRATOR: Embed all unembedded sections for a lesson
// ============================================================================

/**
 * Main entry point: generates embeddings for all unembedded sections of a lesson.
 * 
 * Flow:
 * 1. Query sections WHERE embedding IS NULL for this lesson
 * 2. Batch them into groups of BATCH_SIZE
 * 3. Call OpenAI for each batch
 * 4. Update each row with its embedding
 * 5. Update lesson status
 */
export async function embedLessonSections(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string
): Promise<EmbeddingResult> {

    const result: EmbeddingResult = {
        totalSections: 0,
        alreadyEmbedded: 0,
        newlyEmbedded: 0,
        failedBatches: 0
    };

    // ==========================================
    // 1. Count total sections for this lesson
    // ==========================================
    const { count: totalCount } = await supabase
        .from('document_sections')
        .select('id', { count: 'exact', head: true })
        .eq('lesson_id', lessonId);

    result.totalSections = totalCount || 0;

    if (result.totalSections === 0) {
        console.log(`[Embeddings] No sections found for lesson ${lessonId}`);
        return result;
    }

    // ==========================================
    // 2. Fetch unembedded sections (idempotent)
    // ==========================================
    const { data: unembedded, error: fetchError } = await supabase
        .from('document_sections')
        .select('id, content')
        .eq('lesson_id', lessonId)
        .is('embedding', null)
        .order('chunk_index', { ascending: true });

    if (fetchError) {
        throw new Error(`Failed to fetch sections: ${fetchError.message}`);
    }

    if (!unembedded || unembedded.length === 0) {
        result.alreadyEmbedded = result.totalSections;
        console.log(`[Embeddings] All ${result.totalSections} sections already embedded for lesson ${lessonId}`);
        return result;
    }

    result.alreadyEmbedded = result.totalSections - unembedded.length;
    console.log(
        `[Embeddings] Lesson ${lessonId}: ${unembedded.length} sections to embed ` +
        `(${result.alreadyEmbedded} already done)`
    );

    // ==========================================
    // 3. Update lesson status to 'processing'
    // ==========================================
    await supabase
        .from('lessons')
        .update({ analysis_status: 'processing' })
        .eq('id', lessonId);

    // ==========================================
    // 4. Process in batches
    // ==========================================
    for (let i = 0; i < unembedded.length; i += BATCH_SIZE) {
        const batch = unembedded.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(unembedded.length / BATCH_SIZE);

        console.log(`[Embeddings] Processing batch ${batchNum}/${totalBatches} (${batch.length} sections)`);

        try {
            // Call OpenAI
            const texts = batch.map(s => s.content);
            const embeddings = await callEmbeddingsAPI(texts);

            // Update each row individually
            // (Supabase JS doesn't support bulk UPDATE with different values per row)
            for (let j = 0; j < batch.length; j++) {
                const { error: updateError } = await supabase
                    .from('document_sections')
                    .update({ embedding: JSON.stringify(embeddings[j]) })
                    .eq('id', batch[j].id)
                    .is('embedding', null);  // Double-check: only update if still NULL

                if (updateError) {
                    console.error(
                        `[Embeddings] Failed to update section ${batch[j].id}: ${updateError.message}`
                    );
                    // Continue with remaining sections — don't fail the whole batch
                } else {
                    result.newlyEmbedded++;
                }
            }

        } catch (batchError: any) {
            console.error(
                `[Embeddings] Batch ${batchNum} failed after retries: ${batchError.message}`
            );
            result.failedBatches++;

            // Continue with next batch — partial progress is saved
            // Failed sections remain NULL and will be picked up on retry
        }
    }

    // ==========================================
    // 5. Final status check
    // ==========================================
    const { count: remainingNull } = await supabase
        .from('document_sections')
        .select('id', { count: 'exact', head: true })
        .eq('lesson_id', lessonId)
        .is('embedding', null);

    if (remainingNull === 0) {
        // All sections embedded successfully
        await supabase
            .from('lessons')
            .update({ analysis_status: 'embedded' })
            .eq('id', lessonId);

        console.log(`[Embeddings] ✅ All sections embedded for lesson ${lessonId}`);
    } else if (result.failedBatches > 0) {
        // Some batches failed — leave as 'processing' so retry can pick it up
        console.warn(
            `[Embeddings] ⚠️ ${remainingNull} sections still unembedded for lesson ${lessonId}`
        );
    }

    return result;
}
