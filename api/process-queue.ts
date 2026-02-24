import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// No local processing heavy imports!
export const config = {
    maxDuration: 60 // Return to standard hobby limit (we don't need 300s anymore)
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
    return error?.code === '42883' ||
        (message.includes(functionName.toLowerCase()) && message.includes('does not exist'));
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

    for (let attempt = 0; attempt < 3; attempt++) {
        const { data: nextPending, error: pendingError } = await supabase
            .from('processing_queue')
            .select('id, attempts')
            .in('status', ['pending', 'processing']) // Notice we also allow 'processing' to be picked up for step-based
            .is('locked_by', null)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (pendingError || !nextPending?.id) {
            return null;
        }

        const nowIso = new Date().toISOString();
        const { data: claimed, error: claimError } = await supabase
            .from('processing_queue')
            .update({
                locked_at: nowIso,
                locked_by: workerId,
                attempts: Number(nextPending.attempts || 0) + 1,
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

async function unlockJob(supabase: any, jobId: string, finalStatus?: string): Promise<void> {
    const updates: any = {
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString()
    };
    if (finalStatus) updates.status = finalStatus;

    await supabase.from('processing_queue').update(updates).eq('id', jobId);
}

// ─── Edge Function Execution ────────────────────────────

async function executeEdgeFunctionStep(supabaseUrl: string, serviceKey: string, functionName: string, jobId: string) {
    const url = `${supabaseUrl}/functions/v1/${functionName}`;
    console.log(`[Orchestrator] Calling ${url} for job ${jobId}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

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

        // Attempt to parse JSON response
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
            console.log(`[Orchestrator] Job ${jobId} triggered function ${functionName} and it is now running in the background (timeout reached).`);
            // Gracefully tell Vercel to stay pending while Supabase works in background
            return { success: true, status: 'pending', stage: 'processing_background' };
        }

        throw error;
    }
}

// ─── Job Processor Route logic ────────────────────────

async function processSingleJob(supabase: any, job: any, workerId: string, supabaseUrl: string, serviceKey: string) {
    let result: any;
    let endpoint = '';

    try {
        // Map job_type to Edge Function Name
        if (['pdf_extract', 'audio_transcribe', 'image_ocr', 'embed_sections'].includes(job.job_type)) {
            endpoint = 'ingest-file';
        } else if (job.job_type === 'generate_analysis') {
            endpoint = 'analyze-lesson';
        } else if (job.job_type === 'book_segment') {
            // For now book segmentation might be local or skipped
            throw new Error('Book Segmentation not implemented in Edge Functions yet');
        } else {
            throw new Error(`Unknown job type: ${job.job_type}`);
        }

        // Call the Edge Function Step endpoint
        result = await executeEdgeFunctionStep(supabaseUrl, serviceKey, endpoint, job.id);

        // Status update logic depending on what Edge Function returns
        const finalStatus = (result.status === 'completed' || result.status === 'failed') ? result.status : 'pending';

        // Edge functions updates the specific stage and status rows directly,
        // but the orchestrator must unlock the job so the next Vercel ping can pick it up again.
        await unlockJob(supabase, job.id, finalStatus);

        return {
            jobId: job.id,
            jobType: job.job_type,
            status: finalStatus,
            edgeResult: result
        };

    } catch (processingError: any) {
        console.error(`[${workerId}] Job ${job.id} failed: ${processingError.message}`);

        await unlockJob(supabase, job.id, 'pending'); // unlock it so it can retry or fail

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

        // Enforce maxJobs = 1 so the orchestration is extremely lightweight
        const maxJobs = 1;

        // Requeue stale jobs using RPC
        const { data: requeueCount, error: requeueErr } = await supabase.rpc('requeue_stale_jobs', { max_age_minutes: 5 });
        if (!requeueErr) {
            if (Number(requeueCount) > 0) {
                console.log(`[${workerId}] Requeued ${requeueCount} stale jobs`);
            }
        } else {
            // Fallback for missing RPC: Reset anything locked over 5 mins ago
            const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            await supabase.from('processing_queue')
                .update({ locked_by: null, locked_at: null, status: 'pending' })
                .in('status', ['pending', 'processing'])
                .not('locked_by', 'is', null)
                .lt('locked_at', fiveMinsAgo);
        }

        const startedAt = Date.now();
        const processedJobs: Array<Record<string, any>> = [];

        // 2. Loop and claim just 1 job (maxJobs=1 enforces fast exit)
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

            // This is the core handoff. processSingleJob awaits the quick Edge Function response (max 20s)
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
