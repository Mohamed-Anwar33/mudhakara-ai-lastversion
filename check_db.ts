import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, serviceKey as string);

async function check() {
    const out: string[] = [];
    const log = (s: string) => { out.push(s); };

    const { data: rj } = await supabase.from('processing_queue')
        .select('id, job_type, status, payload, attempt_count, last_error, locked_by, created_at, dedupe_key')
        .like('dedupe_key', '%reanalyze%')
        .order('created_at', { ascending: false }).limit(5);

    log('=== Reanalyze Jobs ===');
    log('Count: ' + (rj?.length || 0));
    if (rj) for (const j of rj) log(JSON.stringify(j, null, 2));

    const { data: active } = await supabase.from('processing_queue')
        .select('id, job_type, status, attempt_count, last_error, locked_by, created_at')
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false }).limit(10);

    log('\n=== Pending/Processing ===');
    log('Count: ' + (active?.length || 0));
    if (active) for (const j of active) log(JSON.stringify(j));

    const { data: tl } = await supabase.from('lessons')
        .select('id').like('lesson_title', '__analysis__%')
        .order('created_at', { ascending: false }).limit(1);
    if (tl && tl[0]) {
        const { data: weakSegs } = await supabase.from('segmented_lectures')
            .select('id, title, status, summary_storage_path, char_count')
            .eq('lesson_id', tl[0].id)
            .or('summary_storage_path.is.null,char_count.lt.500');
        log('\n=== Weak Segments ===');
        log('Lesson: ' + tl[0].id);
        log('Count: ' + (weakSegs?.length || 0));
        if (weakSegs) for (const s of weakSegs) log(`[${s.status}] "${s.title}" chars=${s.char_count} path=${s.summary_storage_path ? 'YES' : 'NULL'} id=${s.id}`);
    }

    fs.writeFileSync('debug_output.txt', out.join('\n'));
    console.log('Written to debug_output.txt');
}
check();
