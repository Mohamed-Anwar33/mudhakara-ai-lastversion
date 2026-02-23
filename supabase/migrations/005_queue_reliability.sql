-- ============================================================================
-- Migration: 005_queue_reliability
-- Purpose:   Queue reliability + multi-file safety + lesson-level dedup
-- Date:      2026-02-23
-- Idempotent: YES
-- ============================================================================

-- ============================================================================
-- 1) Queue uniqueness model
-- ============================================================================

-- Old unique index blocked multiple extraction jobs for same lesson/job_type.
DROP INDEX IF EXISTS idx_processing_queue_active_job;

-- Allow multiple active extraction jobs per lesson as long as file_path differs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_extract_per_file
    ON processing_queue (
        lesson_id,
        job_type,
        COALESCE(payload->>'file_path', '')
    )
    WHERE status IN ('pending', 'processing')
      AND job_type IN ('pdf_extract', 'audio_transcribe', 'image_ocr');

-- Keep singleton behavior for pipeline phase jobs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_singleton_jobs
    ON processing_queue (lesson_id, job_type)
    WHERE status IN ('pending', 'processing')
      AND job_type IN ('embed_sections', 'generate_analysis', 'book_segment');

-- ============================================================================
-- 2) Dedup model for file hashes
-- ============================================================================

-- Replace global hash uniqueness with lesson-level uniqueness.
DROP INDEX IF EXISTS idx_file_hashes_content_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_hashes_lesson_content_hash
    ON file_hashes (lesson_id, content_hash);

-- Helpful lookup index for lesson + path.
CREATE INDEX IF NOT EXISTS idx_file_hashes_lesson_file_path
    ON file_hashes (lesson_id, file_path);

-- ============================================================================
-- 3) Document sections ordering/index support
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_document_sections_lesson_source_file_chunk
    ON document_sections (lesson_id, source_file_id, chunk_index);

-- ============================================================================
-- 4) Requeue stale processing jobs
-- ============================================================================

CREATE OR REPLACE FUNCTION requeue_stale_jobs(max_age_minutes integer DEFAULT 10)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    moved_count integer := 0;
BEGIN
    WITH moved AS (
        UPDATE processing_queue
        SET status = 'pending',
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now(),
            error_message = COALESCE(error_message, '') || CASE
                WHEN COALESCE(error_message, '') = '' THEN 'Requeued: stale processing lock'
                ELSE E'\nRequeued: stale processing lock'
            END
        WHERE status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at < (now() - make_interval(mins => max_age_minutes))
        RETURNING id
    )
    SELECT COUNT(*) INTO moved_count FROM moved;

    RETURN moved_count;
END;
$$;

GRANT EXECUTE ON FUNCTION requeue_stale_jobs(integer) TO service_role;
