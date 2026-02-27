import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function checkJobs() {
    const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89'; // From user logs

    console.log(`Checking queue for lesson: ${lessonId}`);

    const { data: queue, error: qErr } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, error_message, attempt_count, created_at, updated_at')
        .eq('lesson_id', lessonId);

    if (qErr) {
        console.error("Queue query error:", qErr);
        return;
    }

    console.log("\n--- Processing Queue ---");
    console.table(queue);

    const { data: pages, error: pErr } = await supabase
        .from('lesson_pages')
        .select('page_number, status')
        .eq('lesson_id', lessonId);

    console.log("\n--- Lesson Pages ---");
    console.log(`Count: ${pages?.length}`);
    if (pages && pages.length > 0) {
        const counts = pages.reduce((acc, p) => {
            acc[p.status] = (acc[p.status] || 0) + 1;
            return acc;
        }, {});
        console.log(counts);
    }

    const { data: sections, error: sErr } = await supabase
        .from('document_sections')
        .select('id')
        .eq('lesson_id', lessonId);

    console.log("\n--- Document Sections ---");
    console.log(`Count: ${sections?.length}`);

    const { data: activeOrFailed } = await supabase.rpc('check_all_pages_completed', { p_lesson_id: lessonId });
    console.log(`\nRPC check_all_pages_completed result: ${activeOrFailed}`);
}

checkJobs();
