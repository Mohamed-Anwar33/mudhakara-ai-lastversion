-- 008_queue_diagnostics_and_locks.sql
-- Fixes attempt counters, adds robust error tracking, and exponential backoff states

ALTER TABLE processing_queue 
ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_http_status INTEGER,
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Normalize attempts column usage vs attempt_count
-- Drop 'attempts' if it exists to strictly enforce 'attempt_count'
DO $$ BEGIN
    IF EXISTS(SELECT * FROM information_schema.columns 
              WHERE table_name='processing_queue' and column_name='attempts') THEN
        UPDATE processing_queue SET attempt_count = attempts WHERE attempts IS NOT NULL;
        ALTER TABLE processing_queue DROP COLUMN attempts;
    END IF;
END $$;
