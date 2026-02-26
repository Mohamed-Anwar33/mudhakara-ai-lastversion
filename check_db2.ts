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
    const { data: segments } = await supabase.from('lecture_segments')
        .select('*')
        .eq('lesson_id', lessonId)
        .order('page_from', { ascending: true });

    console.log(`segmentsCount: ${segments?.length}`);
    if (segments) {
        segments.forEach((s: any) => console.log(`- ${s.id}: ${s.title} (Page ${s.page_from} to ${s.page_to})`));
    }
}

main().catch(console.error);
