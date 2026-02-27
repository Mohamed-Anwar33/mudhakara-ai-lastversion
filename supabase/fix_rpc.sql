import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function fixRPC() {
  const sql = `
  CREATE OR REPLACE FUNCTION check_all_pages_completed(p_lesson_id UUID)
  RETURNS BOOLEAN AS $$
  DECLARE
    uncompleted_pages INT;
    active_or_failed_ocr_jobs INT;
  BEGIN
    -- Check if any OCR-related jobs are still pending, processing, OR failed
    -- If any are failed, the barrier never clears, which is correct as the job is broken.
    SELECT COUNT(*) INTO active_or_failed_ocr_jobs
    FROM processing_queue
    WHERE lesson_id = p_lesson_id 
      AND job_type IN ('extract_pdf_info', 'ocr_page_batch')
      AND status IN ('pending', 'processing', 'failed');

    IF active_or_failed_ocr_jobs > 0 THEN
      RETURN FALSE;
    END IF;

    -- Check if any existing pages are not successful
    SELECT COUNT(*) INTO uncompleted_pages
    FROM lesson_pages
    WHERE lesson_id = p_lesson_id AND status != 'success';
    
    RETURN uncompleted_pages = 0;
  END;
  $$ LANGUAGE plpgsql;
  `;

  // Executing SQL using run-sql edge function or locally if possible
  // In Vercel environment we can't directly execute raw SQL via JS client easily without rpc
  // Wait, we can use the run_pg.mjs which connects directly using postgres:// URL
  console.log("SQL to execute:\\n", sql);
}
fixRPC();
