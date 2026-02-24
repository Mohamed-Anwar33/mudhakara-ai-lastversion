import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const sb = createClient(supabaseUrl, supabaseKey);

async function run() {
    const { data, error } = await sb
        .from('processing_queue')
        .select('payload, status, stage, error_message, attempts, extraction_cursor')
        .eq('lesson_id', 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89')
        .eq('job_type', 'generate_analysis')
        .order('created_at', { ascending: false })
        .limit(1);

    if (error) {
        console.error(error);
        return;
    }

    if (!data || data.length === 0) {
        console.log('No data found.');
        return;
    }

    console.log({
        status: data[0].status,
        stage: data[0].stage,
        attempts: data[0].attempts,
        cursor: data[0].extraction_cursor,
        err: data[0].error_message
    });
    fs.writeFileSync('payload-dump.json', JSON.stringify(data[0].payload, null, 2), 'utf-8');
    console.log('Saved to payload-dump.json');
}

run();
