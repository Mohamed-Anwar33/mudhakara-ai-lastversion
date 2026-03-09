import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const s = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
    // Get ALL recent jobs
    const { data: jobs, error } = await s.from('processing_queue')
        .select('id, lesson_id, job_type, status, attempt_count, error_message, locked_by, payload')
        .order('created_at', { ascending: false })
        .limit(30);

    if (error) { console.log('Error:', error.message); return; }

    // Group by lesson
    const byLesson: Record<string, any[]> = {};
    for (const j of (jobs || [])) {
        byLesson[j.lesson_id] = byLesson[j.lesson_id] || [];
        byLesson[j.lesson_id].push(j);
    }

    for (const [lid, ljobs] of Object.entries(byLesson)) {
        console.log(`\n=== Lesson: ${lid} ===`);
        for (const j of ljobs) {
            console.log(`  ${j.job_type} | ${j.status} | attempts: ${j.attempt_count} | ${j.error_message?.substring(0, 80) || '-'}`);
            if (j.job_type === 'transcribe_audio') {
                console.log(`    stage: ${j.payload?.stage} | audio: ${j.payload?.audio_url || j.payload?.file_path || 'none'}`);
            }
        }
    }

    // Check segments
    const lessonIds = Object.keys(byLesson);
    for (const lid of lessonIds) {
        const { data: segs } = await s.from('segmented_lectures')
            .select('id, title, status, char_count').eq('lesson_id', lid);
        if (segs && segs.length > 0) {
            console.log(`\n  Segments for ${lid.substring(0, 8)}:`);
            for (const seg of segs) {
                console.log(`    ${seg.status} | ${seg.char_count} chars | ${seg.title?.substring(0, 50)}`);
            }
        } else {
            console.log(`\n  No segments for ${lid.substring(0, 8)}`);
        }
    }

    // Check audio transcript
    for (const lid of lessonIds) {
        const { data: files } = await s.storage.from('audio_transcripts').list(lid);
        if (files && files.length > 0) {
            console.log(`\n  Audio transcript files for ${lid.substring(0, 8)}: ${files.map(f => f.name).join(', ')}`);
        } else {
            console.log(`\n  No audio transcript for ${lid.substring(0, 8)}`);
        }
    }
}

main().catch(e => console.error('FATAL:', e));
