const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // IMPORTANT: use service key to bypass RLS

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase credentials in .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runDiagnostics() {
    console.log('--- DIAGNOSTICS START (SERVICE ROLE) ---');

    // 1. Check Latest Lessons
    console.log('\n--- 1. Latest Lessons ---');
    const { data: lessons, error: errLessons } = await supabase
        .from('lessons')
        .select('id, title, pipeline_stage, created_at')
        .order('created_at', { ascending: false })
        .limit(5);
    if (errLessons) console.error('Error fetching lessons:', errLessons.message);
    else console.table(lessons);

    // 2. Check Processing Queue
    console.log('\n--- 2. Processing Queue (All Jobs) ---');
    const { data: queue, error: errQueue } = await supabase
        .from('processing_queue')
        .select('id, lesson_id, job_type, status, error_message, attempt_count, payload, updated_at')
        .order('created_at', { ascending: false })
        .limit(10);
    if (errQueue) console.error('Error fetching queue:', errQueue.message);
    else {
        // Print without huge payload objects
        const cleaned = queue?.map(q => ({
            ...q,
            payload: q.payload ? '...' : null
        }));
        console.table(cleaned);
    }

    // 3. Audio Transcripts
    console.log('\n--- 3. Audio Transcripts ---');
    const { data: audio, error: errAudio } = await supabase
        .from('audio_transcripts')
        .select('id, lesson_id, status, chunk_index')
        .order('id', { ascending: false }) // or chunk_index if created_at is missing
        .limit(5);
    if (errAudio) console.error('Error fetching audio transcripts:', errAudio.message);
    else console.table(audio);

    console.log('\n--- DIAGNOSTICS END ---');
}

runDiagnostics();
