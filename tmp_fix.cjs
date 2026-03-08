const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function resetAudioToWhisper() {
    const lessonId = '77281931-3ad3-4424-b841-2639df4fa99d';

    console.log(`=== RESETTING AUDIO JOB TO USE WHISPER ===\n`);

    // Find the transcribe_audio job
    const { data: audioJob } = await supabase.from('processing_queue')
        .select('id, payload, status')
        .eq('lesson_id', lessonId).eq('job_type', 'transcribe_audio').single();

    if (!audioJob) { console.log('No audio job found'); return; }
    console.log(`Found job ${audioJob.id} | status=${audioJob.status} | stage=${audioJob.payload?.stage}`);

    // Reset to upload stage with clean payload (forces Whisper-first path)
    const cleanPayload = {
        audio_url: audioJob.payload.audio_url || audioJob.payload.file_path,
        file_path: audioJob.payload.file_path || audioJob.payload.audio_url,
        stage: 'upload'  // Back to Stage 1 — will now try Whisper first (25MB limit)
        // Removed: gemini_file_uri, gemini_file_name, poll_count
    };

    const { error } = await supabase.from('processing_queue').update({
        status: 'pending',
        locked_by: null,
        locked_at: null,
        next_retry_at: null,
        attempt_count: 0,
        error_message: null,
        payload: cleanPayload
    }).eq('id', audioJob.id);

    console.log(`Reset job ${audioJob.id} to upload stage → Whisper first`, error || '✅');
    console.log('New payload:', JSON.stringify(cleanPayload, null, 2));
    console.log('\nAudio-worker will now try Whisper (≤25MB) instead of Gemini!');
}

resetAudioToWhisper().catch(console.error);
