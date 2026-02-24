-- Migration: Add step-based processing columns to processing_queue
ALTER TABLE processing_queue
ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'pending_upload',
ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS gemini_file_uri TEXT,
ADD COLUMN IF NOT EXISTS extraction_cursor INTEGER DEFAULT 0;
