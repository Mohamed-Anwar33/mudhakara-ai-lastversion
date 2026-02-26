import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.APP_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.APP_SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

async function main() {
    const { data: jobs } = await supabase.from('processing_queue').select('id, job_type, payload').eq('lesson_id', lessonId);
    jobs?.forEach((j: any) => {
        if (j.job_type === 'chunk_lecture' || j.job_type === 'analyze_lecture' || j.job_type === 'ocr_range') {
            console.log(`Job ${j.job_type} has lecture_id: ${j.payload?.lecture_id} | pages: ${j.payload?.pages}`);
        }
    });
}

main().catch(console.error);
