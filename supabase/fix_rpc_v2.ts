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
    active_or_failed_ocr_jobs INT;
  BEGIN
    -- V2 Architecture check:
    -- In V2 (ingest-file), we don't insert into lesson_pages anymore, we insert directly into document_sections.
    -- Furthermore, OCR is handled via job_types like: 'ocr_range', 'extract_text_range', 'chunk_lecture'
    -- If any of these jobs are pending, processing, or failed, then OCR is not complete.
    
    SELECT COUNT(*) INTO active_or_failed_ocr_jobs
    FROM processing_queue
    WHERE lesson_id = p_lesson_id 
      AND job_type IN ('extract_pdf_info', 'ocr_page_batch', 'ocr_range', 'extract_text_range', 'chunk_lecture', 'build_lecture_segments', 'extract_toc')
      AND status IN ('pending', 'processing', 'failed');

    -- If there are any incomplete extraction jobs, it's not complete.
    IF active_or_failed_ocr_jobs > 0 THEN
      RETURN FALSE;
    END IF;

    -- If there are no extraction jobs left in pending/processing/failed, then extraction is complete.
    RETURN TRUE;
  END;
  $$ LANGUAGE plpgsql;
  `;

    try {
        console.log("Sending query to Supabase RPC...");
        const res = await fetch(\`\${process.env.VITE_SUPABASE_URL}/functions/v1/run-sql\`, {
         method: 'POST',
         headers: {
             'Authorization': \`Bearer \${process.env.SUPABASE_SERVICE_ROLE_KEY}\`,
             'Content-Type': 'application/json'
         },
         body: JSON.stringify({ query: sql })
     });
     
     if(res.ok) {
         console.log("RPC updated successfully via Edge Function!");
     } else {
         console.error("Failed to update RPC via Edge Function.", await res.text());
     }
  } catch(e) {
      console.error(e);
  }
}
fixRPC();
