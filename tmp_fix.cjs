const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function fixStuckJobs() {
    const lessonId = 'd2e7c63f-9489-4bb6-bbaf-c84f55490774';

    console.log('=== FIXING STUCK JOBS ===\n');

    // 1. Reset all 9 stuck processing ocr_page_batch jobs to COMPLETED
    //    (they already have completed OCR data in lesson_pages — the lock just wasn't released)
    const { data: stuckOcr, error: e1 } = await supabase
        .from('processing_queue')
        .update({
            status: 'completed',
            locked_by: null,
            locked_at: null,
            error_message: 'Auto-healed: stuck processing lock cleared'
        })
        .eq('lesson_id', lessonId)
        .eq('job_type', 'ocr_page_batch')
        .eq('status', 'processing')
        .select('id');

    console.log(`[1] Reset ${stuckOcr?.length || 0} stuck ocr_page_batch jobs to completed`, e1 || '');

    // 2. Reset the segment_lesson job to pending (clear the crash error)
    const { data: segJob, error: e2 } = await supabase
        .from('processing_queue')
        .update({
            status: 'pending',
            locked_by: null,
            locked_at: null,
            next_retry_at: null,
            attempt_count: 0,
            error_message: null
        })
        .eq('lesson_id', lessonId)
        .eq('job_type', 'segment_lesson')
        .select('id');

    console.log(`[2] Reset ${segJob?.length || 0} segment_lesson jobs to pending`, e2 || '');

    // 3. Delete any existing segmented_lectures for this lesson (clean slate for re-segmentation)
    const { data: deleted, error: e3 } = await supabase
        .from('segmented_lectures')
        .delete()
        .eq('lesson_id', lessonId)
        .select('id');

    console.log(`[3] Deleted ${deleted?.length || 0} existing segmented_lectures`, e3 || '');

    // 4. Reset lesson status back to processing
    const { error: e4 } = await supabase
        .from('lessons')
        .update({
            analysis_status: 'processing',
            pipeline_stage: 'segmenting_content'
        })
        .eq('id', lessonId);

    console.log(`[4] Reset lesson status to processing`, e4 || '');

    // 5. Verify final state
    const { data: jobs } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, attempt_count, error_message')
        .eq('lesson_id', lessonId)
        .in('status', ['pending', 'processing', 'failed']);

    console.log(`\n=== REMAINING ACTIVE JOBS ===`);
    for (const j of (jobs || [])) {
        console.log(`  [${j.job_type}] ${j.status} | attempts=${j.attempt_count} | error=${j.error_message?.substring(0, 80) || 'none'}`);
    }

    console.log('\n✅ Done! Deploy the fixed segmentation-worker and the pipeline should resume.');
}

fixStuckJobs().catch(console.error);
