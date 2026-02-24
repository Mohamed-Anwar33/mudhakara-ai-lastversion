import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config({ path: '.env' });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.VITE_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing config");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
    const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';
    console.log(`Checking lesson ${lessonId}...`);

    const { data, error } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, stage, progress, locked_by')
        .eq('lesson_id', lessonId);

    if (error) {
        console.error(error);
    } else {
        fs.writeFileSync('db_dump.json', JSON.stringify(data, null, 2));
        console.log('Saved to db_dump.json');
    }
}

check();
