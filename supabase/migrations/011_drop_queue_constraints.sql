-- Migration: 011_drop_queue_constraints.sql
-- Goal: Fix the bulk insert bug by ensuring duplicate job type constraints are dropped for atomic parallel jobs.

-- 1. Drop the old constraint that prevents parallel jobs for the same lesson
DROP INDEX IF EXISTS idx_processing_queue_active_job;

-- 2. Drop the singleton constraint if it accidentally includes atomic chunking jobs (just to be safe)
DROP INDEX IF EXISTS idx_processing_queue_active_singleton_jobs;

-- 3. Re-create the singleton constraint ONLY for jobs that must strictly be run once per lesson
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_singleton_jobs
    ON processing_queue (lesson_id, job_type)
    WHERE status IN ('pending', 'processing')
      AND job_type IN ('embed_sections', 'generate_analysis', 'book_segment', 'generate_book_overview', 'extract_toc', 'build_lecture_segments');
