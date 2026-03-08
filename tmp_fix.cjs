const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function checkStorage() {
    const lessonId = 'fe5dedf5-10dd-42ba-bf26-244a0183f605';

    // List ALL files in audio_transcripts bucket at root
    console.log('=== Listing audio_transcripts bucket root ===');
    const { data: rootFiles, error: rootErr } = await supabase.storage.from('audio_transcripts').list('', { limit: 50 });
    console.log('Root folders/files:', rootFiles?.map(f => f.name) || [], rootErr?.message);

    // List inside audio_transcripts/ sub dir
    console.log('\n=== Listing audio_transcripts/ subdir ===');
    const { data: subFiles } = await supabase.storage.from('audio_transcripts').list('audio_transcripts', { limit: 50 });
    console.log('audio_transcripts/ contents:', subFiles?.map(f => f.name));

    // List inside lesson ID dir  
    console.log(`\n=== Listing ${lessonId}/ ===`);
    const { data: lessonFiles } = await supabase.storage.from('audio_transcripts').list(lessonId, { limit: 50 });
    console.log(`${lessonId}/ contents:`, lessonFiles?.map(f => f.name));

    // List inside audio_transcripts/{lessonId}/
    console.log(`\n=== Listing audio_transcripts/${lessonId}/ ===`);
    const { data: deepFiles } = await supabase.storage.from('audio_transcripts').list(`audio_transcripts/${lessonId}`, { limit: 50 });
    console.log(`audio_transcripts/${lessonId}/ contents:`, deepFiles?.map(f => f.name));

    // Try download from double-nested path
    const paths = [
        `audio_transcripts/${lessonId}/raw_transcript.txt`,
        `${lessonId}/raw_transcript.txt`,
    ];
    for (const p of paths) {
        const { data, error } = await supabase.storage.from('audio_transcripts').download(p);
        if (data && !error) {
            const text = await data.text();
            console.log(`\n✅ FOUND at: ${p} (${text.length} chars)`);
            console.log(`Preview: ${text.substring(0, 200)}`);
        } else {
            console.log(`\n❌ NOT at: ${p} — ${error?.message || 'unknown'}`);
        }
    }

    // Also check other lessons
    console.log('\n=== ALL lessons with transcribe_audio completed ===');
    const { data: jobs } = await supabase.from('processing_queue')
        .select('lesson_id, status, error_message')
        .eq('job_type', 'transcribe_audio')
        .eq('status', 'completed')
        .order('updated_at', { ascending: false })
        .limit(5);
    for (const j of (jobs || [])) {
        const { data: b } = await supabase.storage.from('audio_transcripts').download(`audio_transcripts/${j.lesson_id}/raw_transcript.txt`);
        console.log(`  ${j.lesson_id}: ${b ? `✅ ${(await b.text()).length} chars` : '❌ NOT FOUND'}`);
    }
}

checkStorage().catch(console.error);
