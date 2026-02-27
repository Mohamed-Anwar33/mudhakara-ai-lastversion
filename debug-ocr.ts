import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseAdmin = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
    console.log("Fetching OCR jobs...");
    const { data: jobs, error } = await supabaseAdmin
        .from('processing_queue')
        .select('*')
        .eq('job_type', 'ocr_page_batch')
        .order('updated_at', { ascending: false })
        .limit(10);

    if (error) {
        console.error("Error fetching jobs:", error);
        return;
    }

    console.log(`Found ${jobs?.length} OCR jobs.`);

    // Check locked_at and status
    for (const job of jobs || []) {
        console.log(`\nJob ID: ${job.id}`);
        console.log(`Status: ${job.status}`);
        console.log(`Progress: ${job.progress}`);
        console.log(`Attempts: ${job.attempts}`);
        console.log(`Locked At: ${job.locked_at}`);
        console.log(`Locked By: ${job.locked_by}`);
        console.log(`Error Msg: ${job.error_message}`);
        console.log(`Payload: ${JSON.stringify(job.payload).substring(0, 150)}...`);
    }
}

main().catch(console.error);
