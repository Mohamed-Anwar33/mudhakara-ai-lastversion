const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function fixNewLesson() {
    const lessonId = 'd1225698-7f2f-4443-9333-e7cabc8f6f59';

    console.log('=== FIXING LESSON', lessonId, '===\n');

    // 1. Reset segment_lesson to pending with cleared attempts
    const { data: segJob } = await supabase.from('processing_queue')
        .update({ status: 'pending', locked_by: null, locked_at: null, attempt_count: 0, error_message: null, next_retry_at: null })
        .eq('lesson_id', lessonId).eq('job_type', 'segment_lesson')
        .select('id');
    console.log(`[1] Reset ${segJob?.length || 0} segment_lesson jobs`);

    // 2. Delete stale segmented_lectures
    const { data: dels } = await supabase.from('segmented_lectures').delete().eq('lesson_id', lessonId).select('id');
    console.log(`[2] Deleted ${dels?.length || 0} stale segmented_lectures`);

    // 3. Reset lesson status
    await supabase.from('lessons').update({ analysis_status: 'processing', pipeline_stage: 'segmenting_content' }).eq('id', lessonId);
    console.log(`[3] Lesson status reset to processing`);

    // 4. Check current state
    const { data: jobs } = await supabase.from('processing_queue')
        .select('id, job_type, status, attempt_count, error_message, payload')
        .eq('lesson_id', lessonId).in('status', ['pending', 'processing', 'failed']);

    console.log(`\n=== ACTIVE/FAILED JOBS ===`);
    for (const j of (jobs || [])) {
        const stage = j.payload?.stage || 'N/A';
        const polls = j.payload?.poll_count || 0;
        console.log(`  [${j.job_type}] ${j.status} | stage=${stage} | polls=${polls} | attempts=${j.attempt_count}`);
    }
    console.log('\n✅ Done! The barrier will now timeout at 5min and proceed with PDF only.');
}

fixNewLesson().catch(console.error);
