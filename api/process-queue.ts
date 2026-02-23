import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { processPdfJob } from './_lib/pdf-processor';
import { processAudioJob } from './_lib/audio-processor.ts';
import { embedLessonSections } from './_lib/embeddings';
import { generateLessonAnalysis } from './_lib/analysis';
import { processImageJob } from './_lib/image-processor.ts';
import { segmentBook } from './_lib/book-segmenter';

export const config = {
    maxDuration: 60
};

const DEFAULT_MAX_JOBS = 3;
const MAX_MAX_JOBS = 10;
const DEFAULT_STALE_MINUTES = 10;
const MAX_RUN_MS = 50_000;

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    return createClient(url, serviceKey);
};

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

async function areEmbeddingsComplete(supabase: any, lessonId: string): Promise<boolean> {
    const { count } = await supabase
        .from('document_sections')
        .select('id', { count: 'exact', head: true })
        .eq('lesson_id', lessonId)
        .is('embedding', null);
    return (count || 0) === 0;
}

async function enqueueEmbeddingJob(supabase: any, lessonId: string): Promise<void> {
    const { error } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId,
        job_type: 'embed_sections',
        payload: { triggered_by: 'extraction_complete' },
        status: 'pending'
    });
    if (error && error.code !== '23505') console.warn(`Enqueue embed failed: ${error.message}`);
}

async function enqueueAnalysisJob(supabase: any, lessonId: string): Promise<void> {
    const { error } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId,
        job_type: 'generate_analysis',
        payload: { triggered_by: 'embedding_complete' },
        status: 'pending'
    });
    if (error && error.code !== '23505') console.warn(`Enqueue analysis failed: ${error.message}`);
}

async function enqueueOcrFallback(supabase: any, lessonId: string, filePath: string, contentHash: string): Promise<void> {
    const { error } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId,
        job_type: 'image_ocr',
        payload: { file_path: filePath, content_hash: contentHash, source_type: 'pdf', fallback_from: 'pdf_extract' },
        status: 'pending'
    });
    if (error && error.code !== '23505') console.warn(`Enqueue OCR fallback failed: ${error.message}`);
}

async function tryEnqueueEmbed(supabase: any, lessonId: string, currentJobId: string, workerId: string): Promise<void> {
    if (await isExtractionComplete(supabase, lessonId, currentJobId)) {
        await enqueueEmbeddingJob(supabase, lessonId);
    } else {
        console.log(`[${workerId}] Other extraction jobs are still pending`);
    }
}

function toPositiveInt(input: unknown, fallback: number, maxValue: number): number {
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.floor(parsed), maxValue);
}

async function processSingleJob(supabase: any, job: any, workerId: string) {
    let result: any;

    try {
        switch (job.job_type) {
            case 'pdf_extract':
                try {
                    result = await processPdfJob(supabase, job.lesson_id, job.payload.file_path, job.payload.content_hash);
                } catch (pdfErr: any) {
                    if (pdfErr.message?.includes('PDF_NEEDS_OCR')) {
                        console.log(`[${workerId}] PDF needs OCR fallback for ${job.payload.file_path}`);
                        await enqueueOcrFallback(supabase, job.lesson_id, job.payload.file_path, job.payload.content_hash);
                        result = { fallback: 'image_ocr', reason: 'PDF_NEEDS_OCR' };
                        break;
                    }
                    throw pdfErr;
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
                if (result.failedBatches === 0 && await areEmbeddingsComplete(supabase, job.lesson_id)) {
                    await enqueueAnalysisJob(supabase, job.lesson_id);
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

        await supabase.rpc('complete_job', { target_job_id: job.id });

        return {
            jobId: job.id,
            lessonId: job.lesson_id,
            jobType: job.job_type,
            status: 'completed',
            result
        };
    } catch (processingError: any) {
        console.error(`[${workerId}] Job ${job.id} failed: ${processingError.message}`);
        await supabase.rpc('fail_job', { target_job_id: job.id, err_msg: processingError.message });

        if ((job.attempts || 0) >= (job.max_attempts || 3)) {
            await supabase.from('lessons')
                .update({ analysis_status: 'failed' })
                .eq('id', job.lesson_id);
        }

        return {
            jobId: job.id,
            lessonId: job.lesson_id,
            jobType: job.job_type,
            status: 'failed',
            error: processingError.message
        };
    }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const supabase = getSupabaseAdmin();
        const maxJobs = toPositiveInt(
            req.query.maxJobs ?? req.body?.maxJobs,
            DEFAULT_MAX_JOBS,
            MAX_MAX_JOBS
        );
        const staleMinutes = toPositiveInt(
            req.query.staleMinutes ?? req.body?.staleMinutes,
            DEFAULT_STALE_MINUTES,
            120
        );

        let requeued = 0;
        const { data: requeueCount, error: requeueError } = await supabase
            .rpc('requeue_stale_jobs', { max_age_minutes: staleMinutes });

        if (requeueError) {
            console.warn(`[${workerId}] requeue_stale_jobs failed: ${requeueError.message}`);
        } else {
            requeued = Number(requeueCount || 0);
            if (requeued > 0) {
                console.log(`[${workerId}] Requeued ${requeued} stale jobs`);
            }
        }

        const startedAt = Date.now();
        const processedJobs: Array<Record<string, any>> = [];

        for (let i = 0; i < maxJobs; i++) {
            if (Date.now() - startedAt > MAX_RUN_MS) {
                break;
            }

            const { data: jobId, error: acquireError } = await supabase
                .rpc('acquire_job', { worker_id: workerId });

            if (acquireError) throw acquireError;
            if (!jobId) break;

            const { data: job, error: fetchError } = await supabase
                .from('processing_queue')
                .select('*')
                .eq('id', jobId)
                .single();

            if (fetchError || !job) {
                processedJobs.push({
                    jobId,
                    status: 'failed',
                    error: `Failed to fetch acquired job: ${fetchError?.message || 'missing job'}`
                });
                continue;
            }

            console.log(`[${workerId}] Processing ${job.job_type} (${job.id})`);
            processedJobs.push(await processSingleJob(supabase, job, workerId));
        }

        const completed = processedJobs.filter(j => j.status === 'completed').length;
        const failed = processedJobs.filter(j => j.status === 'failed').length;
        const elapsedMs = Date.now() - startedAt;

        if (processedJobs.length === 0) {
            return res.status(200).json({
                status: 'idle',
                requeued,
                maxJobs,
                elapsedMs,
                message: 'No pending jobs'
            });
        }

        return res.status(200).json({
            status: failed > 0 ? 'partial' : 'completed',
            processed: processedJobs.length,
            completed,
            failed,
            requeued,
            maxJobs,
            elapsedMs,
            jobs: processedJobs
        });

    } catch (error: any) {
        console.error(`[${workerId}] Worker Error:`, error);
        return res.status(500).json({ error: error.message || 'Worker failed' });
    }
}
