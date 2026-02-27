import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseAdmin = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
    console.log("Resetting stalled OCR jobs...");
    const { data, error } = await supabaseAdmin
        .from('processing_queue')
        .update({ status: 'pending', locked_at: null, locked_by: null })
        .eq('status', 'processing')
        .eq('job_type', 'ocr_page_batch');

    if (error) {
        console.error("Error resetting jobs:", error);
    } else {
        console.log("Jobs reset successfully.");
    }
}

main().catch(console.error);
