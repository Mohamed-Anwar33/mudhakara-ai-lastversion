import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { processPdfJob } from './lib/pdf-processor';
import { processAudioJob } from './lib/audio-processor.ts';
import { embedLessonSections } from './lib/embeddings';
import { generateLessonAnalysis } from './lib/analysis';
import { processImageJob } from './lib/image-processor.ts';
import { segmentBook } from './lib/book-segmenter';

/**
 * Queue Worker — Process one job per invocation.
 *
 * Pipeline: extract → embed → analyze
 *
 * FIX #2: Readiness gates prevent premature transitions:
 *   - embed_sections only enqueued when ALL extractions complete
 *   - generate_analysis only enqueued when ALL embeddings complete
 */

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    return createClient(url, serviceKey);
};

// ─── Readiness Gates ────────────────────────────────────

/**
 * Check if ALL extraction jobs for this lesson are done.
 * Excludes the current job (still 'processing' until complete_job).
 */
async function isExtractionComplete(supabase: any, lessonId: string, excludeJobId: string): Promise<boolean> {
    const { count } = await supabase
        .from('processing_queue')
        .select('id', { count: 'exact', head: true })
        .eq('lesson_id', lessonId)
        .in('job_type', ['pdf_extract', 'audio_transcribe', 'image_ocr'])
        .in('status', ['pending', 'processing'])
        .neq('id', excludeJobId);
    return (count || 0) === 0;
}

/**
 * Check if ALL sections for this lesson have embeddings.
 */
async function areEmbeddingsComplete(supabase: any, lessonId: string): Promise<boolean> {
    const { count } = await supabase
        .from('document_sections')
        .select('id', { count: 'exact', head: true })
        .eq('lesson_id', lessonId)
        .is('embedding', null);
    return (count || 0) === 0;
}

// ─── Enqueue Helpers ────────────────────────────────────

async function enqueueEmbeddingJob(supabase: any, lessonId: string): Promise<void> {
    const { error } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId, job_type: 'embed_sections',
        payload: { triggered_by: 'extraction_complete' }, status: 'pending'
    });
    if (error && error.code !== '23505') console.warn(`Enqueue embed failed: ${error.message}`);
}

async function enqueueAnalysisJob(supabase: any, lessonId: string): Promise<void> {
    const { error } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId, job_type: 'generate_analysis',
        payload: { triggered_by: 'embedding_complete' }, status: 'pending'
    });
    if (error && error.code !== '23505') console.warn(`Enqueue analysis failed: ${error.message}`);
}

/** Enqueue OCR job as fallback when PDF text extraction fails (N1 fix). */
async function enqueueOcrFallback(supabase: any, lessonId: string, filePath: string, contentHash: string): Promise<void> {
    const { error } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId, job_type: 'image_ocr',
        payload: { file_path: filePath, content_hash: contentHash, source_type: 'pdf', fallback_from: 'pdf_extract' },
        status: 'pending'
    });
    if (error && error.code !== '23505') console.warn(`Enqueue OCR fallback failed: ${error.message}`);
}

/** After extraction completes, check if embed is ready (shared helper). */
async function tryEnqueueEmbed(supabase: any, lessonId: string, currentJobId: string, workerId: string): Promise<void> {
    if (await isExtractionComplete(supabase, lessonId, currentJobId)) {
        await enqueueEmbeddingJob(supabase, lessonId);
    } else {
        console.log(`[${workerId}] Other extractions pending — deferring embed`);
    }
}

// ─── Handler ────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const supabase = getSupabaseAdmin();

        // 1. Acquire next job
        const { data: jobId, error: acquireError } = await supabase
            .rpc('acquire_job', { worker_id: workerId });
        if (acquireError) throw acquireError;

        if (!jobId) {
            return res.status(200).json({ status: 'idle', message: 'لا توجد وظائف في الانتظار' });
        }

        // 2. Fetch job details
        const { data: job, error: fetchError } = await supabase
            .from('processing_queue').select('*').eq('id', jobId).single();
        if (fetchError || !job) throw new Error(`Failed to fetch job ${jobId}`);

        console.log(`[${workerId}] Processing ${job.job_type} (${job.id})`);

        // 3. Route to handler
        let result: any;
        try {
            switch (job.job_type) {
                case 'pdf_extract':
                    try {
                        result = await processPdfJob(supabase, job.lesson_id, job.payload.file_path, job.payload.content_hash);
                    } catch (pdfErr: any) {
                        // N1 FIX: Scanned/encrypted PDF → auto-fallback to OCR via GPT-4o Vision
                        if (pdfErr.message?.includes('PDF_NEEDS_OCR')) {
                            console.log(`[${workerId}] PDF text extraction failed → enqueueing OCR fallback`);
                            await enqueueOcrFallback(supabase, job.lesson_id, job.payload.file_path, job.payload.content_hash);
                            result = { fallback: 'image_ocr', reason: 'PDF_NEEDS_OCR' };
                            break; // Don't re-throw — mark this job completed, OCR job takes over
                        }
                        throw pdfErr; // Other errors: normal failure path
                    }
                    await tryEnqueueEmbed(supabase, job.lesson_id, job.id, workerId);
                    break;

                case 'audio_transcribe':
                    result = await processAudioJob(supabase, job.lesson_id, job.payload.file_path, job.payload.content_hash);
                    await tryEnqueueEmbed(supabase, job.lesson_id, job.id, workerId);
                    break;

                case 'image_ocr':
                    result = await processImageJob(supabase, job.lesson_id, job.payload.file_path, job.payload.content_hash);
                    await tryEnqueueEmbed(supabase, job.lesson_id, job.id, workerId);
                    break;

                case 'embed_sections':
                    result = await embedLessonSections(supabase, job.lesson_id);
                    // FIX #2: Only enqueue analysis when ALL embeddings done
                    if (result.failedBatches === 0 && await areEmbeddingsComplete(supabase, job.lesson_id)) {
                        await enqueueAnalysisJob(supabase, job.lesson_id);
                    } else if (result.failedBatches > 0) {
                        console.warn(`[${workerId}] ${result.failedBatches} batches failed — not enqueueing analysis`);
                    }
                    break;

                case 'generate_analysis':
                    result = await generateLessonAnalysis(supabase, job.lesson_id);
                    break;

                case 'book_segment':
                    result = await segmentBook(
                        supabase,
                        job.payload.subject_id,
                        job.payload.user_id,
                        job.payload.file_path
                    );
                    break;

                default:
                    throw new Error(`Unknown job type: ${job.job_type}`);
            }

            // 4. Mark completed
            await supabase.rpc('complete_job', { target_job_id: jobId });

            return res.status(200).json({
                status: 'completed', jobId: job.id, jobType: job.job_type,
                result, message: 'تمت المعالجة بنجاح'
            });

        } catch (processingError: any) {
            console.error(`[${workerId}] Job ${job.id} failed:`, processingError.message);
            await supabase.rpc('fail_job', { target_job_id: jobId, err_msg: processingError.message });

            if (job.attempts >= 2) {
                await supabase.from('lessons')
                    .update({ analysis_status: 'failed' })
                    .eq('id', job.lesson_id);
            }

            return res.status(200).json({ status: 'failed', jobId: job.id, error: processingError.message });
        }

    } catch (error: any) {
        console.error(`[${workerId}] Worker Error:`, error);
        return res.status(500).json({ error: error.message || 'خطأ في العامل' });
    }
}
