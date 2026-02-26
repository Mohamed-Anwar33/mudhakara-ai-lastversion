import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.APP_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.APP_SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

async function main() {
    const { count: segmentsCount } = await supabase.from('lecture_segments')
        .select('id', { count: 'exact', head: true }).eq('lesson_id', lessonId);

    const { data: allSegments } = await supabase.from('lecture_segments').select('id').eq('lesson_id', lessonId);
    const segIds = allSegments?.map((s: any) => s.id) || [];

    let analysisCount = 0;
    if (segIds.length > 0) {
        const res = await supabase.from('lecture_analysis')
            .select('id', { count: 'exact', head: true }).in('lecture_id', segIds);
        analysisCount = res.count || 0;
    }

    console.log(`segmentsCount: ${segmentsCount}`);
    console.log(`analysisCount: ${analysisCount}`);
    console.log(`Are they equal? ${segmentsCount === analysisCount}`);

    // Also check jobs
    const { data: jobs } = await supabase.from('processing_queue').select('id, job_type, status').eq('lesson_id', lessonId);
    console.log('Jobs:', jobs);
}

main().catch(console.error);
