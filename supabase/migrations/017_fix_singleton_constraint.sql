-- Migration: 017_fix_singleton_constraint.sql
-- Purpose: Remove analyze_lecture and generate_quiz from singleton constraint
-- They need MULTIPLE jobs per lesson (one per segmented lecture)
-- Date: 2026-03-08
-- Idempotent: YES

-- ============================================================================
-- FIX: analyze_lecture and generate_quiz need MULTIPLE instances per lesson
-- The old constraint only allowed ONE per (lesson_id, job_type)
-- ============================================================================
DROP INDEX IF EXISTS idx_processing_queue_active_singleton_jobs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_singleton_jobs
    ON processing_queue (lesson_id, job_type)
    WHERE status IN ('pending', 'processing')
      AND job_type IN (
        'segment_lesson',
        'finalize_global_summary',
        'generate_analysis',
        'generate_book_overview',
        'embed_sections',
        'extract_toc',
        'build_lecture_segments',
        'book_segment'
      );
-- REMOVED: 'analyze_lecture', 'generate_quiz' — these need multiple jobs per lesson
