import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Vercel API Route: POST /api/reanalyze-direct
 * 
 * Queue-based re-analysis: creates analyze_lecture jobs in processing_queue.
 * Returns immediately (<1s). Edge Functions handle the actual Gemini work.
 * Body: { lessonId: string, lectureId: string }
 *    OR { lessonId: string, lectureIds: string[] }  (batch mode)
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
        const { lessonId, lectureId, lectureIds } = req.body || {};
        if (!lessonId) {
            return res.status(400).json({ error: 'Missing lessonId' });
        }

        const supabase = getSupabaseAdmin();

        // Support both single lectureId and batch lectureIds
        const ids: string[] = lectureIds || (lectureId ? [lectureId] : []);
        if (ids.length === 0) {
            return res.status(400).json({ error: 'Missing lectureId or lectureIds' });
        }

        console.log(`🔄 [Reanalyze] Queuing ${ids.length} lectures for lesson ${lessonId}`);

        // Get segment details for all lectures
        const { data: segments } = await supabase.from('segmented_lectures')
            .select('id, title, start_page, end_page')
            .in('id', ids);

        if (!segments || segments.length === 0) {
            return res.status(404).json({ error: 'No segments found' });
        }

        // Reset segment status to 'pending' so they get reanalyzed
        await supabase.from('segmented_lectures')
            .update({ status: 'pending' })
            .in('id', ids);

        // Delete any existing analyze_lecture/generate_quiz jobs for these lectures
        // to prevent dedupe conflicts — use EXACT dedupe_key match (not LIKE, which fails with UUIDs)
        const dedupeKeys = segments.map(seg => `lesson:${lessonId}:analyze_lecture:${seg.id}`);
        for (const key of dedupeKeys) {
            await supabase.from('processing_queue')
                .delete()
                .eq('dedupe_key', key);
        }
        // Also delete any quiz jobs for these lectures
        for (const seg of segments) {
            await supabase.from('processing_queue')
                .delete()
                .eq('lesson_id', lessonId)
                .eq('job_type', 'generate_quiz')
                .like('dedupe_key', `%${seg.id}%`);
        }

        // Create fresh analyze_lecture jobs with ALL fields properly reset
        const jobsToInsert = segments.map(seg => ({
            lesson_id: lessonId,
            job_type: 'analyze_lecture',
            payload: {
                lecture_id: seg.id,
                title: seg.title,
                start_page: seg.start_page,
                end_page: seg.end_page,
                reanalyze: true
            },
            status: 'pending',
            attempt_count: 0,
            error_message: null,
            locked_by: null,
            locked_at: null,
            next_retry_at: null,
            dedupe_key: `lesson:${lessonId}:analyze_lecture:${seg.id}`
        }));

        // Use insert (not upsert) since we deleted old jobs above
        const { error: insertErr } = await supabase.from('processing_queue')
            .insert(jobsToInsert);

        if (insertErr) {
            console.error(`[Reanalyze] Job insert error:`, insertErr.message);
            // Fallback: try inserting one by one
            let created = 0;
            for (const job of jobsToInsert) {
                const { error } = await supabase.from('processing_queue').insert(job);
                if (!error) created++;
                else console.warn(`[Reanalyze] Single insert failed: ${error.message}`);
            }
            console.log(`[Reanalyze] Fallback: created ${created}/${jobsToInsert.length} jobs`);
        }

        // Ensure lesson is in processing state
        await supabase.from('lessons').update({
            analysis_status: 'processing'
        }).eq('id', lessonId);

        console.log(`✅ [Reanalyze] Queued ${segments.length} analyze_lecture jobs`);

        // Fire-and-forget: trigger process-queue immediately so jobs don't wait for cron
        const selfUrl = req.headers?.origin || req.headers?.host || '';
        const baseUrl = selfUrl.startsWith('http') ? selfUrl : `https://${selfUrl}`;
        fetch(`${baseUrl}/api/process-queue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'reanalyze' })
        }).catch(() => { }); // Fire and forget

        return res.json({
            success: true,
            queued: segments.length,
            lectures: segments.map(s => ({ id: s.id, title: s.title })),
            message: `تم إرسال ${segments.length} درس/دروس لإعادة التحليل. سيبدأ التحليل خلال ثوانٍ.`
        });

    } catch (error: any) {
        console.error('❌ [Reanalyze] Error:', error);
        return res.status(500).json({ error: error.message || 'Reanalysis queuing failed' });
    }
}
