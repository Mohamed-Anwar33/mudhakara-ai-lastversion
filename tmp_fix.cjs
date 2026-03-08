const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function fixNow() {
    const lessonId = '6397a7af-0ada-45f9-86ca-35b17bbb7ae8';
    console.log(`=== FIX STUCK OCR FOR ${lessonId} ===\n`);

    // 1. Find the stuck OCR job (attempt >= 4, pending or processing)
    const { data: stuckOcr } = await supabase.from('processing_queue')
        .select('id, status, attempt_count')
        .eq('lesson_id', lessonId)
        .eq('job_type', 'ocr_page_batch')
        .in('status', ['pending', 'processing'])
        .gte('attempt_count', 3);

    if (stuckOcr && stuckOcr.length > 0) {
        console.log(`Found ${stuckOcr.length} stuck OCR job(s). Marking as failed...`);
        for (const s of stuckOcr) {
            await supabase.from('processing_queue').update({
                status: 'failed',
                error_message: `OCR failed after ${s.attempt_count} attempts - skipping`,
                locked_by: null, locked_at: null
            }).eq('id', s.id);
            console.log(`  ✅ Marked ${s.id} as failed (was ${s.status}, attempts=${s.attempt_count})`);
        }
    } else {
        console.log('No stuck OCR jobs found (all completed or already failed)');
    }

    // 2. Fix lesson status
    await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);
    console.log(`\nLesson status set to processing. segment_lesson should now pass the barrier!`);
}

fixNow().catch(console.error);
