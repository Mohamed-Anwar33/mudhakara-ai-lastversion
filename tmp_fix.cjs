const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function fullReset() {
    const lessonId = '77281931-3ad3-4424-b841-2639df4fa99d';
    console.log(`=== FULL RESET for ${lessonId} ===\n`);

    // 1. check ALL jobs
    const { data: allJobs } = await supabase.from('processing_queue')
        .select('id, job_type, status, payload, attempt_count, error_message')
        .eq('lesson_id', lessonId)
        .order('created_at', { ascending: true });

    console.log(`Total jobs: ${allJobs?.length || 0}`);
    for (const j of (allJobs || [])) {
        const stage = j.payload?.stage || '-';
        const polls = j.payload?.poll_count || 0;
        const err = j.error_message ? j.error_message.substring(0, 60) : '';
        console.log(`  [${j.job_type}] ${j.status} | stage=${stage} | polls=${polls} | attempts=${j.attempt_count} | ${err}`);
    }

    // 2. Reset transcribe_audio to upload stage for Whisper
    const { data: audioReset } = await supabase.from('processing_queue')
        .update({
            status: 'pending',
            locked_by: null, locked_at: null, next_retry_at: null,
            attempt_count: 0, error_message: null,
            payload: {
                audio_url: (allJobs || []).find(j => j.job_type === 'transcribe_audio')?.payload?.audio_url || (allJobs || []).find(j => j.job_type === 'transcribe_audio')?.payload?.file_path,
                file_path: (allJobs || []).find(j => j.job_type === 'transcribe_audio')?.payload?.file_path || (allJobs || []).find(j => j.job_type === 'transcribe_audio')?.payload?.audio_url,
                stage: 'upload'
            }
        })
        .eq('lesson_id', lessonId).eq('job_type', 'transcribe_audio')
        .select('id');
    console.log(`\n[1] Reset ${audioReset?.length || 0} audio job(s) to upload/Whisper stage`);

    // 3. Make sure lesson is NOT failed
    const { data: lesson } = await supabase.from('lessons')
        .select('analysis_status, pipeline_stage')
        .eq('id', lessonId).single();
    console.log(`[2] Lesson status: ${lesson?.analysis_status} | stage: ${lesson?.pipeline_stage}`);

    if (lesson?.analysis_status === 'failed') {
        await supabase.from('lessons').update({
            analysis_status: 'processing',
            pipeline_stage: 'audio_transcription'
        }).eq('id', lessonId);
        console.log(`[3] Reset lesson from failed → processing`);
    }

    console.log('\n✅ All done. Audio will now try Whisper first (up to 25MB).');
}

fullReset().catch(console.error);
