-- Fix: acquire_job RPC ignores next_retry_at
-- This causes segment_lesson (barrier) and transcribe_audio (multi-stage)
-- to be re-dispatched immediately instead of waiting.

CREATE OR REPLACE FUNCTION acquire_job(worker_id TEXT)
RETURNS UUID AS $$
DECLARE
  claimed_id UUID;
BEGIN
  UPDATE processing_queue
  SET 
    status = 'processing',
    locked_by = worker_id,
    locked_at = NOW(),
    attempt_count = COALESCE(attempt_count, 0) + 1,
    updated_at = NOW()
  WHERE id = (
    SELECT id FROM processing_queue
    WHERE status = 'pending'
      AND locked_by IS NULL
      AND (next_retry_at IS NULL OR next_retry_at <= NOW())
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING id INTO claimed_id;
  
  RETURN claimed_id;
END;
$$ LANGUAGE plpgsql;
