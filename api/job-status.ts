import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getRequestSearchParams } from './_lib/request-url.js';

/**
 * Vercel API Route: /api/job-status
 * 
 * يسمح للعميل بالاستعلام عن حالة معالجة ملف معين.
 * GET /api/job-status?jobId=xxx  أو  GET /api/job-status?lessonId=xxx
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Strict Cache-Busting Headers
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    try {
        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);
        const searchParams = getRequestSearchParams(req);
        const jobId = searchParams.get('jobId');
        const lessonId = searchParams.get('lessonId');

        // Query by jobId
        if (jobId) {
            const { data, error } = await supabase
                .from('processing_queue')
                .select('id, job_type, status, attempts, error_message, created_at, completed_at, stage, progress')
                .eq('id', jobId)
                .single();

            if (error) throw error;
            return res.status(200).json(data);
        }

        // Query by lessonId
        if (lessonId) {
            const { data, error } = await supabase
                .from('processing_queue')
                .select('id, job_type, status, attempts, error_message, created_at, completed_at, stage, progress')
                .eq('lesson_id', lessonId)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const { data: lesson } = await supabase
                .from('lessons')
                .select('analysis_status, analysis_result')
                .eq('id', lessonId)
                .single();

            console.log(`[JobStatus Debug] Lesson ${lessonId} | Jobs count: ${data?.length}`);
            if (data && data.length > 0) {
                console.log(`[JobStatus Debug] Jobs map:`, data.map((j: any) => `${j.job_type}=${j.status}(${j.stage})`).join(' | '));
            }

            return res.status(200).json({
                jobs: data,
                lessonStatus: lesson?.analysis_status,
                analysisResult: lesson?.analysis_result
            });
        }

        return res.status(400).json({ error: 'يجب تحديد jobId أو lessonId' });

    } catch (error: any) {
        console.error('Job Status Error:', error);
        return res.status(500).json({
            error: error.message || 'حدث خطأ أثناء جلب الحالة'
        });
    }
}
