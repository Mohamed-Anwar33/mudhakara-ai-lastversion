import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// No local processing heavy imports!
export const config = {
    maxDuration: 10 // Vercel Free plan limit = 10 seconds
};

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    return createClient(url, serviceKey);
};

// ─── Concurrency Locks ──────────────────────────────────

function isMissingFunctionError(error: any, functionName: string): boolean {
    const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
    // 42883 = undefined_function, PGRST203 = overloaded/ambiguous function
    return error?.code === '42883' || error?.code === 'PGRST203' ||
        (message.includes(functionName.toLowerCase()) && (message.includes('does not exist') || message.includes('candidate function')));
}

async function acquireJobId(supabase: any, workerId: string): Promise<string | null> {
    const { data: rpcJobId, error: rpcError } = await supabase
        .rpc('acquire_job', { worker_id: workerId });

    if (!rpcError) {
        return rpcJobId || null;
    }

    if (!isMissingFunctionError(rpcError, 'acquire_job')) {
        throw rpcError;
    }

    console.warn(`[${workerId}] acquire_job RPC missing. Using SQL fallback lock flow.`);

    // Enforce Concurrency Limits
    // FIX: Count ALL 'processing' jobs (not just locked ones)
    // After 6.5s timeout, lock is released but Edge Function still runs.
    // Old check (.not('locked_by', 'is', null)) always returned 0!
    const { count: activeOcr } = await supabase.from('processing_queue')
        .select('*', { count: 'exact', head: true })
        .in('job_type', ['ocr_range', 'image_ocr', 'ocr_page_batch'])
        .eq('status', 'processing');

    const { count: activeAnalysis } = await supabase.from('processing_queue')
        .select('*', { count: 'exact', head: true })
        .in('job_type', ['generate_analysis', 'analyze_lecture'])
        .eq('status', 'processing');

    const { count: activeQuiz } = await supabase.from('processing_queue')
        .select('*', { count: 'exact', head: true })
        .eq('job_type', 'generate_quiz')
        .eq('status', 'processing');

    const excludedTypes: string[] = [];
    if ((activeOcr || 0) >= 5) excludedTypes.push('ocr_range', 'image_ocr', 'ocr_page_batch');
    if ((activeAnalysis || 0) >= 4) excludedTypes.push('generate_analysis', 'analyze_lecture');
    if ((activeQuiz || 0) >= 4) excludedTypes.push('generate_quiz');

    for (let attempt = 0; attempt < 3; attempt++) {
        let query = supabase
            .from('processing_queue')
            .select('id, attempt_count')
            .eq('status', 'pending')  // Only claim pending jobs — processing jobs are actively running in Edge Functions
            .is('locked_by', null)
            .or('next_retry_at.lte.now(),next_retry_at.is.null') // Respect exponential backoff
            .order('created_at', { ascending: true })
            .limit(1);

        if (excludedTypes.length > 0) {
            query = query.not('job_type', 'in', `(${excludedTypes.join(',')})`);
        }

        const { data: nextPending, error: pendingError } = await query.maybeSingle();

        if (pendingError || !nextPending?.id) {
            return null;
        }

        const nowIso = new Date().toISOString();
        const { data: claimed, error: claimError } = await supabase
            .from('processing_queue')
            .update({
                status: 'processing',  // Mark as processing immediately to prevent re-acquisition
                locked_at: nowIso,
                locked_by: workerId,
                attempt_count: Number(nextPending.attempt_count || 0) + 1,
                updated_at: nowIso
            })
            .eq('id', nextPending.id)
            .is('locked_by', null)
            .select('id')
            .maybeSingle();

        if (claimError && claimError.code !== 'PGRST116') { // Ignore zero-row updates safely
            throw claimError;
        }

        if (claimed?.id) {
            return claimed.id;
        }
    }

    return null;
}

async function unlockJob(supabase: any, jobId: string, finalStatus?: string, customUpdates?: any): Promise<void> {
    const updates: any = {
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
        ...(customUpdates || {})
    };
    if (finalStatus) updates.status = finalStatus;

    await supabase.from('processing_queue').update(updates).eq('id', jobId);
}

// ─── Edge Function Execution ────────────────────────────

async function executeEdgeFunctionStep(supabaseUrl: string, serviceKey: string, functionName: string, jobId: string) {
    const url = `${supabaseUrl}/functions/v1/${functionName}`;
    console.log(`[Orchestrator] Calling ${url} for job ${jobId}`);

    const controller = new AbortController();
    // Vercel Free = 10s max. Keep 3.5s for overhead → 6.5s for Edge Function call.
    const timeoutId = setTimeout(() => controller.abort(), 6500);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ jobId }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
            const errorText = await res.text().catch(() => 'No response body');
            throw new Error(`Edge Function returned ${res.status}: ${errorText}`);
        }

        let data;
        try {
            data = await res.json();
        } catch {
            throw new Error('Edge Function returned invalid JSON');
        }

        return data;

    } catch (error: any) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            console.log(`[Orchestrator] Edge Function still running (>8s). Disconnecting gracefully. Releasing lock.`);
            return { status: 'dispatched', message: 'Edge function triggered but still running', unlockNeeded: true };
        }

        throw error;
    }
}

// ─── Job Processor Route logic ────────────────────────

async function processSingleJob(supabase: any, job: any, workerId: string, supabaseUrl: string, serviceKey: string) {
    let result: any;
    let endpoint = '';

    try {
        // V2 Architecture Route Mapping
        if (['extract_pdf_info', 'ocr_page_batch'].includes(job.job_type)) {
            endpoint = 'ocr-worker';
            if (job.job_type === 'extract_pdf_info') {
                await supabase.from('lessons').update({ pipeline_stage: 'extracting_text' }).eq('id', job.lesson_id);
            }
        } else if (['transcribe_audio', 'extract_audio_focus'].includes(job.job_type)) {
            endpoint = 'audio-worker';
        } else if (['segment_lesson'].includes(job.job_type)) {
            endpoint = 'segmentation-worker';
            await supabase.from('lessons').update({ pipeline_stage: 'segmenting_content' }).eq('id', job.lesson_id);
        } else if (['analyze_lecture'].includes(job.job_type)) {
            endpoint = 'analyze-lesson';
            await supabase.from('lessons').update({ pipeline_stage: 'generating_summary' }).eq('id', job.lesson_id);
        } else if (['generate_quiz'].includes(job.job_type)) {
            endpoint = 'quiz-generator';
            await supabase.from('lessons').update({ pipeline_stage: 'generating_quizzes' }).eq('id', job.lesson_id);
        } else if (['finalize_global_summary'].includes(job.job_type)) {
            endpoint = 'global-aggregator';
        } else if (['extract_text_range'].includes(job.job_type)) {
            endpoint = 'extract-text-node';
        } else if (['ingest_upload', 'ingest_extract', 'ingest_chunk', 'pdf_extract', 'audio_transcribe', 'image_ocr', 'embed_sections', 'extract_toc', 'build_lecture_segments', 'ocr_range', 'chunk_lecture', 'embed_lecture'].includes(job.job_type)) {
            endpoint = 'ingest-file';
        } else if (['generate_analysis', 'generate_book_overview'].includes(job.job_type)) {
            endpoint = 'analyze-lesson';
        } else if (job.job_type === 'book_segment') {
            throw new Error('Book Segmentation logic moved to segment_lesson');
        } else {
            throw new Error(`Unknown job type: ${job.job_type}`);
        }

        // Call the appropriate handler
        if (endpoint === 'extract-text-node') {
            const parseModule = await import('./_lib/parse-pdf.js');
            result = await parseModule.processExtractTextRange(supabase, job);
        } else {
            result = await executeEdgeFunctionStep(supabaseUrl, serviceKey, endpoint, job.id);
        }

        // If dispatched (fire-and-forget), release lock but keep processing
        if (result?.status === 'dispatched' && result?.unlockNeeded) {
            await supabase.from('processing_queue').update({
                locked_by: null,
                locked_at: null,
                updated_at: new Date().toISOString()
            }).eq('id', job.id);
        } else if (result?.status !== 'dispatched') {
            await unlockJob(supabase, job.id);
        }

        return {
            jobId: job.id,
            jobType: job.job_type,
            status: result.status || 'pending',
            edgeResult: result
        };

    } catch (processingError: any) {
        console.error(`[${workerId}] Job ${job.id} failed: ${processingError.message}`);

        const failedAttempts = Number(job.attempt_count || 0);
        if (failedAttempts >= 5) {
            console.error(`[${workerId}] Job ${job.id} has reached max attempts (5) and is FAILED.`);
            await supabase.from('processing_queue').update({
                status: 'failed',
                error_message: processingError.message,
                locked_by: null,
                locked_at: null
            }).eq('id', job.id);

            if (['extract_pdf_info', 'transcribe_audio', 'segment_lesson', 'analyze_lecture', 'finalize_global_summary'].includes(job.job_type)) {
                await supabase.from('lessons').update({
                    analysis_status: 'failed',
                    pipeline_stage: 'failed'
                }).eq('id', job.lesson_id);
            }
        } else {
            await unlockJob(supabase, job.id, 'pending');
        }

        return {
            jobId: job.id,
            jobType: job.job_type,
            status: 'error',
            error: processingError.message
        };
    }
}

// ─── Main Orchestrator ──────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const supabase = getSupabaseAdmin();
        const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

        const maxJobs = 1;

        // Fallback cleanup for locked jobs older than 3 minutes
        const staleLockCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        const { data: staleJobs } = await supabase
            .from('processing_queue')
            .select('id, attempt_count')
            .in('status', ['pending', 'processing'])
            .not('locked_by', 'is', null)
            .lt('locked_at', staleLockCutoff);

        if (staleJobs && staleJobs.length > 0) {
            console.log(`[${workerId}] Found ${staleJobs.length} stale locked jobs. Cleaning up...`);
            for (const stale of staleJobs) {
                const currentAttempts = Number(stale.attempt_count || 0);
                if (currentAttempts >= 5) {
                    const { data: claimed } = await supabase.from('processing_queue')
                        .update({ status: 'failed', error_message: 'Background processing timeout exceeded multiple times', locked_by: null, locked_at: null })
                        .eq('id', stale.id)
                        .not('locked_by', 'is', null)
                        .select('id').maybeSingle();
                    if (claimed) console.log(`[${workerId}] Stale job ${stale.id} marked as FAILED (${currentAttempts} attempts).`);
                } else {
                    const { data: claimed } = await supabase.from('processing_queue')
                        .update({ status: 'pending', locked_by: null, locked_at: null })
                        .eq('id', stale.id)
                        .not('locked_by', 'is', null)
                        .select('id').maybeSingle();
                    if (claimed) console.log(`[${workerId}] Reset stale job ${stale.id} to pending.`);
                }
            }
        }

        // ═══ ORPHANED JOB RECOVERY ═══
        // Jobs stuck in 'processing' with NO lock and not updated in 3+ minutes
        const orphanCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        const { data: orphanedJobs } = await supabase
            .from('processing_queue')
            .select('id, attempt_count')
            .eq('status', 'processing')
            .is('locked_by', null)
            .lt('updated_at', orphanCutoff);

        if (orphanedJobs && orphanedJobs.length > 0) {
            console.log(`[${workerId}] Found ${orphanedJobs.length} orphaned processing jobs. Resetting to pending...`);
            for (const orphan of orphanedJobs) {
                const attempts = Number(orphan.attempt_count || 0);
                if (attempts >= 5) {
                    const { data: claimed } = await supabase.from('processing_queue')
                        .update({ status: 'failed', error_message: 'Orphaned job exceeded recovery attempts', locked_by: null, locked_at: null })
                        .eq('id', orphan.id)
                        .eq('status', 'processing')
                        .select('id').maybeSingle();
                    if (claimed) console.log(`[${workerId}] Orphaned job ${orphan.id} marked as FAILED (${attempts} attempts).`);
                } else {
                    const { data: claimed } = await supabase.from('processing_queue')
                        .update({ status: 'pending', locked_by: null, locked_at: null })
                        .eq('id', orphan.id)
                        .eq('status', 'processing')
                        .select('id').maybeSingle();
                    if (claimed) console.log(`[${workerId}] Reset orphaned job ${orphan.id} to pending (attempt_count stays at ${attempts}).`);
                }
            }
        }

        const startedAt = Date.now();
        const processedJobs: Array<Record<string, any>> = [];

        for (let i = 0; i < maxJobs; i++) {
            const jobId = await acquireJobId(supabase, workerId);
            if (!jobId) {
                console.log(`[${workerId}] No available jobs to claim.`);
                break;
            }

            const { data: job, error: fetchError } = await supabase
                .from('processing_queue')
                .select('*')
                .eq('id', jobId)
                .single();

            if (fetchError || !job) {
                await unlockJob(supabase, jobId);
                continue;
            }

            console.log(`[${workerId}] Orchestrating ${job.job_type} (${job.id})`);
            processedJobs.push(await processSingleJob(supabase, job, workerId, supabaseUrl, serviceKey));
        }

        const elapsedMs = Date.now() - startedAt;

        if (processedJobs.length === 0) {
            return res.status(200).json({ status: 'idle', elapsedMs, message: 'No pending jobs' });
        }

        const lastJob = processedJobs[0];

        return res.status(200).json({
            status: 'ok',
            executed: 1,
            elapsedMs,
            jobResult: lastJob
        });

    } catch (error: any) {
        console.error(`[${workerId}] Orchestrator Error:`, error);
        return res.status(500).json({ error: error.message || 'Orchestrator failed' });
    }
}
