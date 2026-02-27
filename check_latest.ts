import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function main() {
    const { data: lessons, error: lErr } = await supabase
        .from('lessons')
        .select('id, created_at, analysis_status, title')
        .order('created_at', { ascending: false })
        .limit(1);

    if (lErr) return console.error(lErr);
    if (!lessons?.length) return console.log('No lessons');

    const l = lessons[0];
    console.log('Last lesson:', l);

    const { data: jobs, error: jErr } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, stage, error_message, progress, created_at, updated_at')
        .eq('lesson_id', l.id)
        .order('created_at', { ascending: true });

    if (jErr) return console.error(jErr);
    console.log(JSON.stringify(jobs, null, 2));

    // Check segments and analyze
    const { data: segments } = await supabase.from('segmented_lectures').select('id, title, status').eq('lesson_id', l.id);
    console.log('Segments:', segments);
}

main();
