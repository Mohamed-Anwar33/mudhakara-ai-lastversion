import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Vercel API Route: POST /api/retry-failed
 * 
 * يعيد تشغيل الجوبات الفاشلة فقط بدون إعادة تحليل الكتاب كله.
 * Body: { lessonId: string }
 */

export const config = {
    maxDuration: 10
};

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error('Missing env vars');
    return createClient(url, serviceKey);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { lessonId } = req.body || {};
        if (!lessonId) {
            return res.status(400).json({ error: 'Missing lessonId' });
        }

        const supabase = getSupabaseAdmin();

        // 1. Find all FAILED jobs for this lesson
        const { data: failedJobs, error: fetchErr } = await supabase
            .from('processing_queue')
            .select('id, job_type, attempt_count, error_message, payload')
            .eq('lesson_id', lessonId)
            .eq('status', 'failed');

        if (fetchErr) throw fetchErr;

        if (!failedJobs || failedJobs.length === 0) {
            return res.status(200).json({
                status: 'no_failed_jobs',
                message: 'لا توجد محاضرات فاشلة لإعادة تحليلها',
                retriedCount: 0
            });
        }

        // Filter out permanently failed jobs that can never succeed by retrying
        const retryableJobs = failedJobs.filter((j: any) => {
            // Skip audio jobs that exhausted Gemini polling (file can't be processed)
            if (j.job_type === 'transcribe_audio') {
                const pollCount = j.payload?.poll_count || 0;
                if (pollCount >= 30) {
                    console.log(`[retry-failed] Skipping transcribe_audio ${j.id}: Gemini permanently failed (${pollCount} polls)`);
                    return false;
                }
            }
            return true;
        });

        if (retryableJobs.length === 0) {
            return res.status(200).json({
                status: 'no_retryable_jobs',
                message: 'المهام الفاشلة غير قابلة لإعادة المحاولة',
                retriedCount: 0
            });
        }

        console.log(`[retry-failed] Found ${retryableJobs.length} retryable jobs (of ${failedJobs.length} failed) for lesson ${lessonId}`);

        // 2. Reset retryable failed jobs to 'pending' with attempt_count reset
        const resetResults = [];
        for (const job of retryableJobs) {
            const { error: updateErr } = await supabase
                .from('processing_queue')
                .update({
                    status: 'pending',
                    error_message: null,
                    locked_by: null,
                    locked_at: null,
                    attempt_count: 0,
                    next_retry_at: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', job.id);

            if (!updateErr) {
                resetResults.push({
                    jobId: job.id,
                    jobType: job.job_type,
                    previousError: job.error_message
                });
            }
        }

        // 3. Also reset any segmented_lectures that might be stuck
        //    (if analyze_lecture or generate_quiz failed, the lecture status might need resetting)
        const analyzeJobTypes = failedJobs.filter(j =>
            ['analyze_lecture', 'generate_quiz'].includes(j.job_type)
        );

        if (analyzeJobTypes.length > 0) {
            // Reset segmented_lectures that aren't fully done
            const { data: stuckLectures } = await supabase
                .from('segmented_lectures')
                .select('id, status')
                .eq('lesson_id', lessonId)
                .not('status', 'eq', 'quiz_done');

            if (stuckLectures && stuckLectures.length > 0) {
                for (const lec of stuckLectures) {
                    // Reset to appropriate status based on what failed
                    const hasAnalyzeFailed = analyzeJobTypes.some(j => j.job_type === 'analyze_lecture');
                    const newStatus = hasAnalyzeFailed ? 'pending' : 'summary_done';
                    await supabase.from('segmented_lectures')
                        .update({ status: newStatus })
                        .eq('id', lec.id);
                }
                console.log(`[retry-failed] Reset ${stuckLectures.length} stuck segmented_lectures`);
            }
        }

        // 4. Reset lesson status back to processing (not failed)
        await supabase.from('lessons').update({
            analysis_status: 'processing',
            pipeline_stage: 'retrying_failed'
        }).eq('id', lessonId);

        console.log(`[retry-failed] Successfully reset ${resetResults.length} failed jobs to pending`);

        return res.status(200).json({
            status: 'retried',
            message: `تم إعادة ${resetResults.length} محاضرة فاشلة للتحليل`,
            retriedCount: resetResults.length,
            retriedJobs: resetResults
        });

    } catch (error: any) {
        console.error('[retry-failed] Error:', error);
        return res.status(500).json({
            error: error.message || 'حدث خطأ أثناء إعادة التحليل'
        });
    }
}
