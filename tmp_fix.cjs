const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function deepDiagnose() {
    const lessonId = 'faf5df0f-313f-4412-83cf-a5f37b181e35';

    // 1. Check audio source info
    const { data: lesson } = await supabase.from('lessons')
        .select('lesson_title, sources, audio_url, audio_transcript')
        .eq('id', lessonId).single();

    console.log('=== LESSON INFO ===');
    console.log('Title:', lesson?.lesson_title);
    const audioSources = (lesson?.sources || []).filter(s => s.type === 'audio');
    console.log('Audio sources:', JSON.stringify(audioSources, null, 2));
    console.log('audio_url field:', lesson?.audio_url || 'NONE');
    console.log('audio_transcript length:', (lesson?.audio_transcript || '').length);

    // 2. Check audio file size  
    for (const src of audioSources) {
        const path = src.content || src.uploadedUrl?.split('/homework-uploads/')[1] || '';
        if (path) {
            const cleanPath = decodeURIComponent(path.trim()).replace(/^\/+/, '').split('?')[0];
            console.log('\nChecking audio file:', cleanPath);
            const { data: signedUrl } = await supabase.storage.from('homework-uploads').createSignedUrl(cleanPath, 60);
            if (signedUrl?.signedUrl) {
                const head = await fetch(signedUrl.signedUrl, { method: 'HEAD' });
                const size = parseInt(head.headers.get('content-length') || '0');
                const type = head.headers.get('content-type');
                console.log(`  Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
                console.log(`  Type: ${type}`);
            }
        }
    }

    // 3. Check transcribe_audio job details
    const { data: audioJobs } = await supabase.from('processing_queue')
        .select('*')
        .eq('lesson_id', lessonId)
        .eq('job_type', 'transcribe_audio');

    console.log('\n=== TRANSCRIBE JOBS ===');
    for (const j of (audioJobs || [])) {
        console.log(`Status: ${j.status}`);
        console.log(`Attempts: ${j.attempt_count}`);
        console.log(`Error: ${j.error_message}`);
        console.log(`Payload stage: ${j.payload?.stage}`);
        console.log(`Payload keys: ${Object.keys(j.payload || {}).join(', ')}`);
    }

    // 4. Read the actual transcript
    const { data: blob } = await supabase.storage.from('ocr').download(`${lessonId}/audio_transcript.txt`);
    if (blob) {
        const text = await blob.text();
        console.log(`\n=== TRANSCRIPT (${text.length} chars) ===`);
        console.log(text);
    }

    // 5. Check segments
    const { data: segs } = await supabase.from('segmented_lectures')
        .select('id, title, start_page, end_page, status')
        .eq('lesson_id', lessonId)
        .order('start_page');

    console.log(`\n=== SEGMENTS (${segs?.length || 0}) ===`);
    const audioSegs = (segs || []).filter(s => s.title?.includes('صوت'));
    console.log(`Audio segments: ${audioSegs.length}`);
    for (const s of audioSegs) {
        console.log(`  "${s.title}" | pages ${s.start_page}-${s.end_page} | ${s.status}`);
    }

    // Show first 5 segments for context
    for (const s of (segs || []).slice(0, 5)) {
        console.log(`  [${s.start_page}-${s.end_page}] "${s.title}" | ${s.status}`);
    }
}

deepDiagnose().catch(console.error);
