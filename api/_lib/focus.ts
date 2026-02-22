import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Focus Extraction Module
 *
 * Compares audio (teacher speech) embeddings with PDF (textbook) sections
 * via match_sections RPC to identify "focus areas" the teacher emphasized.
 *
 * Flow:
 *   1. Fetch sections by type (pdf / audio / image)
 *   2. For each audio chunk → match_sections(embedding, source='pdf')
 *   3. Dynamic threshold → filter
 *   4. Deduple & merge → cap at 20 passages
 */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

// ─── Types ──────────────────────────────────────────────

export interface FocusPdfSection {
    id: string;
    content: string;
    chunk_index: number;
    matched_audio_ids: string[];
    max_similarity: number;
}

export interface FocusResult {
    focusPdfSections: FocusPdfSection[];
    audioExcerpts: Array<{ id: string; content: string; chunk_index: number }>;
    imageContext: string | null;
    stats: {
        totalAudioChunks: number;
        totalPdfChunks: number;
        matchedPdfChunks: number;
        avgSimilarity: number;
        threshold: number;
    };
}

// ─── Helpers ────────────────────────────────────────────

/** Compute single embedding (fallback when DB value is NULL). */
async function computeSingleEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY must be set');

    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
    });
    if (!res.ok) throw new Error(`Embedding error (${res.status}): ${await res.text()}`);
    const json = await res.json();
    return json.data[0].embedding;
}

/** N3 FIX: Batch compute embeddings for multiple texts at once. */
async function computeBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY must be set');

    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
    });
    if (!res.ok) throw new Error(`Batch embedding error (${res.status}): ${await res.text()}`);
    const json = await res.json();
    return json.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((d: any) => d.embedding);
}

/** Parse embedding from DB — handles array, string, null. */
function parseEmbedding(raw: any): number[] | null {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
    return null;
}

/** Dynamic threshold: max(floor, mean + 1.0·std). Lowered floor for Arabic PDFs. */
function dynamicThreshold(scores: number[], floor = 0.35): number {
    if (scores.length === 0) return floor;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length;
    // Use 1.0 std dev (instead of 1.5) to keep more matches
    return Math.max(floor, mean + 1.0 * Math.sqrt(variance));
}

// ─── Main ───────────────────────────────────────────────

export async function buildFocusMap(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string
): Promise<FocusResult> {

    // 1. Fetch sections — two queries to avoid loading PDF embeddings (L1 optimization)
    //    PDF/Image: only need id, content, chunk_index (no embedding → saves ~6KB per chunk)
    //    Audio: need embedding for similarity matching

    const { data: pdfImageSections, error: piErr } = await supabase
        .from('document_sections')
        .select('id, content, chunk_index, source_type')
        .eq('lesson_id', lessonId)
        .in('source_type', ['pdf', 'image'])
        .order('chunk_index', { ascending: true });

    const { data: audioSections, error: audioErr } = await supabase
        .from('document_sections')
        .select('id, content, chunk_index, source_type, embedding')
        .eq('lesson_id', lessonId)
        .eq('source_type', 'audio')
        .order('chunk_index', { ascending: true });

    if (piErr) throw new Error(`Fetch PDF/image failed: ${piErr.message}`);
    if (audioErr) throw new Error(`Fetch audio failed: ${audioErr.message}`);
    if (!pdfImageSections?.length && !audioSections?.length) {
        throw new Error(`No sections for lesson ${lessonId}`);
    }

    const pdf = (pdfImageSections || []).filter((s: any) => s.source_type === 'pdf');
    const audio = audioSections || [];
    const image = (pdfImageSections || []).filter((s: any) => s.source_type === 'image');

    // Fallback: no audio → treat all PDF as focused
    if (audio.length === 0) {
        console.log(`[Focus] No audio sections — using all PDF content`);
        return {
            focusPdfSections: pdf.slice(0, 20).map((s: any) => ({
                id: s.id, content: s.content, chunk_index: s.chunk_index,
                matched_audio_ids: [], max_similarity: 1.0
            })),
            audioExcerpts: [],
            imageContext: image.length > 0
                ? image.map((s: any) => s.content).join('\n').substring(0, 2000) : null,
            stats: {
                totalAudioChunks: 0, totalPdfChunks: pdf.length,
                matchedPdfChunks: Math.min(pdf.length, 20), avgSimilarity: 1.0, threshold: 0
            }
        };
    }

    // 2. N3 FIX: Batch-compute missing audio embeddings upfront (instead of 1-by-1)
    const missingEmbedAudio = audio.filter((s: any) => !parseEmbedding(s.embedding));
    if (missingEmbedAudio.length > 0) {
        console.log(`[Focus] Batch computing ${missingEmbedAudio.length} missing audio embeddings`);
        try {
            const embeddings = await computeBatchEmbeddings(missingEmbedAudio.map((s: any) => s.content));
            for (let i = 0; i < missingEmbedAudio.length; i++) {
                missingEmbedAudio[i].embedding = embeddings[i]; // patch in-memory
                await supabase.from('document_sections')
                    .update({ embedding: JSON.stringify(embeddings[i]) })
                    .eq('id', missingEmbedAudio[i].id).is('embedding', null);
            }
        } catch (batchErr: any) {
            console.warn(`[Focus] Batch embed failed, falling back to single: ${batchErr.message}`);
            // Fallback: compute one-by-one (will happen in the matching loop below)
        }
    }

    // 3. For each audio chunk → match PDF via match_sections RPC
    //    PERFORMANCE: Parallel with concurrency limit (5x faster than sequential)
    const chunkLookup = new Map(pdf.map((s: any) => [s.id, s.chunk_index]));
    const rawMatches: Array<{ pdf_id: string; pdf_content: string; audio_id: string; similarity: number }> = [];
    const allScores: number[] = [];

    const CONCURRENCY = 5; // Max parallel RPC calls

    /** Process a single audio chunk: ensure embedding exists → match_sections RPC */
    const processAudioChunk = async (audioSec: any) => {
        let embedding = parseEmbedding(audioSec.embedding);
        if (!embedding) {
            console.log(`[Focus] Single embedding fallback for audio ${audioSec.id}`);
            embedding = await computeSingleEmbedding(audioSec.content);
            await supabase.from('document_sections')
                .update({ embedding: JSON.stringify(embedding) })
                .eq('id', audioSec.id).is('embedding', null);
        }

        const { data: matches, error: matchErr } = await supabase
            .rpc('match_sections', {
                query_embedding: JSON.stringify(embedding),
                match_threshold: 0.3,
                match_count: 20,
                filter_lesson_id: lessonId,
                filter_source: 'pdf'
            });

        if (matchErr) { console.warn(`[Focus] match error ${audioSec.id}: ${matchErr.message}`); return; }

        for (const m of (matches || [])) {
            rawMatches.push({ pdf_id: m.id, pdf_content: m.content, audio_id: audioSec.id, similarity: m.similarity });
            allScores.push(m.similarity);
        }
    };

    // Run in batches of CONCURRENCY for controlled parallelism
    for (let i = 0; i < audio.length; i += CONCURRENCY) {
        const batch = audio.slice(i, i + CONCURRENCY);
        console.log(`[Focus] Matching batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(audio.length / CONCURRENCY)} (${batch.length} chunks)...`);
        await Promise.allSettled(batch.map(processAudioChunk));
    }

    // 3. Dynamic threshold
    const threshold = dynamicThreshold(allScores);
    const filtered = rawMatches.filter(m => m.similarity >= threshold);
    console.log(`[Focus] ${rawMatches.length} raw → threshold ${threshold.toFixed(3)} → ${filtered.length} kept`);

    // 4. Dedupe by pdf_section_id, keep highest similarity
    const pdfMap = new Map<string, { id: string; content: string; chunk_index: number; audioIds: Set<string>; maxSim: number }>();
    for (const m of filtered) {
        const existing = pdfMap.get(m.pdf_id);
        if (existing) {
            existing.audioIds.add(m.audio_id);
            existing.maxSim = Math.max(existing.maxSim, m.similarity);
        } else {
            pdfMap.set(m.pdf_id, {
                id: m.pdf_id, content: m.pdf_content,
                chunk_index: chunkLookup.get(m.pdf_id) ?? 0,
                audioIds: new Set([m.audio_id]), maxSim: m.similarity
            });
        }
    }

    // Sort by similarity, cap at 20
    const focusSorted = Array.from(pdfMap.values())
        .sort((a, b) => b.maxSim - a.maxSim).slice(0, 20);

    // 5. Collect matching audio excerpts
    const usedAudioIds = new Set<string>();
    focusSorted.forEach(f => f.audioIds.forEach(id => usedAudioIds.add(id)));
    const audioExcerpts = audio
        .filter((s: any) => usedAudioIds.has(s.id))
        .map((s: any) => ({ id: s.id, content: s.content.substring(0, 500), chunk_index: s.chunk_index }));

    const imageContext = image.length > 0
        ? image.map((s: any) => s.content).join('\n').substring(0, 2000) : null;

    const avgSim = focusSorted.length > 0
        ? focusSorted.reduce((s, f) => s + f.maxSim, 0) / focusSorted.length : 0;

    return {
        focusPdfSections: focusSorted.map(f => ({
            id: f.id, content: f.content, chunk_index: f.chunk_index,
            matched_audio_ids: Array.from(f.audioIds), max_similarity: f.maxSim
        })),
        audioExcerpts,
        imageContext,
        stats: {
            totalAudioChunks: audio.length, totalPdfChunks: pdf.length,
            matchedPdfChunks: focusSorted.length, avgSimilarity: avgSim, threshold
        }
    };
}
