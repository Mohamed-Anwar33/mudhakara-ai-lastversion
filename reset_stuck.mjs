import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function resetJobs() {
    const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

    console.log(`Resetting failed jobs for lesson: ${lessonId}\n`);

    // 1. Reset failed OCR batches
    const { data: updatedQueue, error: uErr } = await supabase
        .from('processing_queue')
        .update({ status: 'pending', locked_by: null, locked_at: null, attempt_count: 0, error_message: null })
        .eq('lesson_id', lessonId)
        .in('job_type', ['ocr_page_batch', 'ocr_range', 'chunk_lecture'])
        .eq('status', 'failed')
        .select('id, job_type');

    if (uErr) {
        console.error("Queue update error:", uErr);
    } else {
        console.log(`Reset ${updatedQueue?.length} OCR jobs in queue`, updatedQueue);
    }

    // 2. Reset failed lesson pages
    const { data: updatedPages, error: pErr } = await supabase
        .from('lesson_pages')
        .update({ status: 'pending', retry_count: 0 })
        .eq('lesson_id', lessonId)
        .eq('status', 'failed')
        .select('page_number');

    if (pErr) {
        console.error("Pages update error:", pErr);
    } else {
        console.log(`Reset ${updatedPages?.length} lesson pages`);
    }

    // 3. Reset segment_lesson job if it exists and is hanging
    await supabase
        .from('processing_queue')
        .update({ status: 'pending', locked_by: null, locked_at: null, attempt_count: 0 })
        .eq('lesson_id', lessonId)
        .eq('job_type', 'segment_lesson');

    console.log("Reset complete. The Orchestrator should now pick up the pending jobs and finish the OCR process.");
}

resetJobs();
