-- Migration: 012_drop_dead_tables.sql
-- Purpose: Remove tables that are no longer used by the active pipeline
-- These tables were part of the original design (migration 010) but the pipeline
-- was rewritten to use processing_queue, document_sections, and lessons.analysis_result instead.
-- Date: 2026-02-26
-- Idempotent: YES — All statements use IF EXISTS.

-- 1. Drop dead tables that nothing reads from or writes to
DROP TABLE IF EXISTS public.final_lesson_output CASCADE;
DROP TABLE IF EXISTS public.audio_transcripts CASCADE;
DROP TABLE IF EXISTS public.document_chunks CASCADE;
DROP TABLE IF EXISTS public.analysis_jobs CASCADE;

-- 2. Clean up any orphaned indexes from migration 010
DROP INDEX IF EXISTS idx_analysis_jobs_lesson_id;
DROP INDEX IF EXISTS idx_doc_chunks_job_id;
DROP INDEX IF EXISTS idx_doc_chunks_lesson_id;
DROP INDEX IF EXISTS idx_audio_transcripts_job_id;
DROP INDEX IF EXISTS idx_audio_transcripts_lesson_id;
