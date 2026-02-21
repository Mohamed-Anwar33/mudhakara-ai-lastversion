-- ============================================================================
-- ROLLBACK for 001_ai_content_analysis
-- WARNING: This will DELETE all AI pipeline data permanently.
-- Safe to run even if migration partially failed.
-- ============================================================================

-- 1. Drop tables first (CASCADE handles triggers, policies, indexes automatically)
DROP TABLE IF EXISTS dead_jobs CASCADE;
DROP TABLE IF EXISTS file_hashes CASCADE;
DROP TABLE IF EXISTS processing_queue CASCADE;
DROP TABLE IF EXISTS document_sections CASCADE;

-- 2. Drop functions
DROP FUNCTION IF EXISTS match_sections;
DROP FUNCTION IF EXISTS acquire_job;
DROP FUNCTION IF EXISTS complete_job;
DROP FUNCTION IF EXISTS fail_job;
DROP FUNCTION IF EXISTS update_updated_at_column;

-- 3. Remove columns added to lessons
ALTER TABLE lessons DROP COLUMN IF EXISTS analysis_result;
ALTER TABLE lessons DROP COLUMN IF EXISTS analysis_status;
ALTER TABLE lessons DROP COLUMN IF EXISTS version;
ALTER TABLE lessons DROP COLUMN IF EXISTS schema_version;

-- 4. Drop enums
DROP TYPE IF EXISTS processing_status;
DROP TYPE IF EXISTS section_source_type;

-- 5. Extensions (only drop if no other features depend on them)
-- DROP EXTENSION IF EXISTS vector;
-- DROP EXTENSION IF EXISTS pg_trgm;
-- NOTE: Commented out by default. Dropping extensions can break other features.

-- ============================================================================
-- ROLLBACK COMPLETE
-- ============================================================================
