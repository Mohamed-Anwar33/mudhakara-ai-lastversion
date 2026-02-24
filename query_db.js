import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
    console.error('No URL or KEY found.');
    process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
    console.log('Resetting stuck jobs...');
    const { data: updated, error: updErr } = await supabase
        .from('processing_queue')
        .update({ status: 'pending', locked_by: null, locked_at: null })
        .eq('status', 'processing')
        .is('locked_by', null)
        .select('id, job_type, status');

    if (updErr) {
        console.error('Failed to reset:', updErr);
    } else {
        console.log(`Successfully reset ${updated.length} zombie jobs.`, updated);
    }
}

run();
