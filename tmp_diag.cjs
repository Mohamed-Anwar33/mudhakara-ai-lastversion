const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function diagnose() {
    const lessonId = 'd2e7c63f-9489-4bb6-bbaf-c84f55490774';

    // 1. Get ALL jobs for this lesson
    const { data: jobs, error } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, stage, attempt_count, error_message, locked_by, locked_at, next_retry_at, payload, created_at, updated_at')
        .eq('lesson_id', lessonId)
        .order('created_at', { ascending: true });

    if (error) { console.error('Query error:', error); return; }

    console.log(`\n=== LESSON ${lessonId} ===`);
    console.log(`Total jobs: ${jobs.length}\n`);

    // Group by status
    const statusGroups = {};
    for (const j of jobs) {
        if (!statusGroups[j.status]) statusGroups[j.status] = [];
        statusGroups[j.status].push(j);
    }

    for (const [status, group] of Object.entries(statusGroups)) {
        console.log(`--- ${status.toUpperCase()} (${group.length}) ---`);
        for (const j of group) {
            const payloadStage = j.payload?.stage || 'N/A';
            const pollCount = j.payload?.poll_count || 0;
            const audioUrl = j.payload?.audio_url || j.payload?.file_path || '';
            const geminiUri = j.payload?.gemini_file_uri || '';
            console.log(`  [${j.job_type}] id=${j.id.substring(0, 8)} | stage=${j.stage} | payload.stage=${payloadStage} | attempts=${j.attempt_count} | polls=${pollCount}`);
            if (j.error_message) console.log(`    error: ${j.error_message.substring(0, 120)}`);
            if (j.locked_by) console.log(`    locked_by: ${j.locked_by} | locked_at: ${j.locked_at}`);
            if (j.next_retry_at) console.log(`    next_retry_at: ${j.next_retry_at} (now: ${new Date().toISOString()})`);
            if (audioUrl) console.log(`    audio/file: ${audioUrl.substring(0, 80)}`);
            if (geminiUri) console.log(`    gemini_uri: ${geminiUri}`);
        }
    }

    // 2. Check lesson status
    const { data: lesson } = await supabase
        .from('lessons')
        .select('analysis_status, pipeline_stage, audio_url, sources')
        .eq('id', lessonId)
        .single();

    console.log(`\n=== LESSON STATUS ===`);
    console.log(`  analysis_status: ${lesson?.analysis_status}`);
    console.log(`  pipeline_stage: ${lesson?.pipeline_stage}`);
    console.log(`  audio_url: ${lesson?.audio_url || 'null'}`);
    console.log(`  sources: ${JSON.stringify(lesson?.sources || [])}`);
}

diagnose().catch(console.error);
