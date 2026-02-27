import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function deepDive() {
    const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

    console.log(`Deep dive for lesson: ${lessonId}\n`);

    const { data: q } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, error_message, attempt_count, updated_at, locked_by')
        .eq('lesson_id', lessonId);

    console.log("--- Queue Items ---");
    console.table(q);

    const { data: rpcRes } = await supabase.rpc('check_all_pages_completed', { p_lesson_id: lessonId });
    console.log(`\nRPC check_all_pages_completed: ${rpcRes}`);
}

deepDive();
