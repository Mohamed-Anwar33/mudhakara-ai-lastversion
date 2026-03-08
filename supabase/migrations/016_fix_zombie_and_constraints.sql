-- Migration: 016_fix_zombie_and_constraints.sql
-- Purpose: Fix zombie jobs, singleton constraints for new pipeline jobs, and ambiguous acquire_job RPC
-- Date: 2026-03-08
-- Idempotent: YES

-- ============================================================================
-- 1. CLEANUP: Mark stale zombie jobs as failed
-- Jobs stuck in pending/processing for >1 hour are zombies
-- ============================================================================
UPDATE processing_queue
SET status = 'failed',
    error_message = 'Cleanup: stale zombie job (stuck >1 hour)',
    locked_by = NULL,
    locked_at = NULL,
    updated_at = NOW()
WHERE status IN ('pending', 'processing')
  AND created_at < NOW() - INTERVAL '1 hour';

-- ============================================================================
-- 2. FIX: Drop ambiguous acquire_job(TEXT, TEXT) overload
-- Migration 001 created acquire_job(worker_id TEXT, target_job_type TEXT)
-- Migration 010/015 created acquire_job(worker_id TEXT) — 1 param
-- PostgreSQL keeps BOTH as overloads → causes PGRST203 ambiguity errors
-- ============================================================================
DROP FUNCTION IF EXISTS acquire_job(TEXT, TEXT);

-- ============================================================================
-- 3. DEDUP: Remove duplicate active jobs BEFORE creating unique index
-- Keep only the NEWEST job per (lesson_id, job_type) for active singleton types
-- ============================================================================
WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY lesson_id, job_type
           ORDER BY created_at DESC
         ) AS rn
  FROM processing_queue
  WHERE status IN ('pending', 'processing')
    AND job_type IN (
      'segment_lesson', 'analyze_lecture', 'generate_quiz',
      'finalize_global_summary', 'generate_analysis',
      'generate_book_overview', 'embed_sections',
      'extract_toc', 'build_lecture_segments', 'book_segment'
    )
)
UPDATE processing_queue
SET status = 'failed',
    error_message = 'Cleanup: duplicate active job removed',
    locked_by = NULL,
    locked_at = NULL,
    updated_at = NOW()
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- ============================================================================
-- 4. FIX: Update singleton constraints for ALL pipeline-phase jobs
-- Now safe because duplicates have been cleaned up above.
-- ============================================================================
DROP INDEX IF EXISTS idx_processing_queue_active_singleton_jobs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_singleton_jobs
    ON processing_queue (lesson_id, job_type)
    WHERE status IN ('pending', 'processing')
      AND job_type IN (
        'segment_lesson',
        'analyze_lecture',
        'generate_quiz',
        'finalize_global_summary',
        'generate_analysis',
        'generate_book_overview',
        'embed_sections',
        'extract_toc',
        'build_lecture_segments',
        'book_segment'
      );

-- ============================================================================
-- 5. FIX: Add dedupe_key column if not exists + unique constraint
-- Used by audio-worker to prevent duplicate segment_lesson jobs
-- ============================================================================
ALTER TABLE processing_queue
ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Create unique index for dedupe (only for active jobs)
DROP INDEX IF EXISTS idx_processing_queue_dedupe_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_dedupe_unique
    ON processing_queue (dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing');

-- ============================================================================
-- 6. FIX: Add next_retry_at column if not exists
-- Used for backoff in multi-stage jobs (audio-worker polling, segmentation barrier)
-- ============================================================================
ALTER TABLE processing_queue
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
