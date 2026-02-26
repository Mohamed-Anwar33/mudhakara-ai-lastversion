import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.APP_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.APP_SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

async function main() {
    const { data: job } = await supabase.from('processing_queue')
        .select('payload')
        .eq('lesson_id', lessonId)
        .eq('job_type', 'build_lecture_segments')
        .single();

    console.log(JSON.stringify(job?.payload?.toc || {}, null, 2));
}

main().catch(console.error);
