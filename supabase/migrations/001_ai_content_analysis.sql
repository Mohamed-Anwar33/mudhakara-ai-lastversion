-- ============================================================================
-- Migration: 001_ai_content_analysis
-- Purpose:   Foundation for the AI Content Analysis Pipeline
-- Author:    AI Systems Architect
-- Date:      2026-02-19
-- Idempotent: YES — Safe to re-run. All statements use IF NOT EXISTS / IF EXISTS.
-- ============================================================================

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

-- pgvector: Required for embedding storage and similarity search.
-- vector type provides 1536-dimension float arrays for text-embedding-3-small.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- pg_trgm: Required for BM25-like trigram text search (hybrid search component).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- ============================================================================
-- 2. ENUMS
-- ============================================================================

-- Processing status lifecycle: pending -> processing -> completed | failed | dead
DO $$ BEGIN
    CREATE TYPE processing_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Source type of a document section (what generated this chunk)
DO $$ BEGIN
    CREATE TYPE section_source_type AS ENUM ('pdf', 'audio', 'image', 'text');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 3. ALTER EXISTING TABLES
-- ============================================================================

-- Add AI pipeline columns to the existing lessons table.
-- analysis_result: JSONB blob containing summary, focus_points, quiz.
-- analysis_status: Tracks whether AI processing is done for this lesson.
-- version: Optimistic concurrency control — increment on every write.
-- schema_version: Tracks the JSON schema version for lazy migration.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lessons' AND column_name = 'analysis_result'
    ) THEN
        ALTER TABLE lessons ADD COLUMN analysis_result JSONB DEFAULT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lessons' AND column_name = 'analysis_status'
    ) THEN
        ALTER TABLE lessons ADD COLUMN analysis_status processing_status DEFAULT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lessons' AND column_name = 'version'
    ) THEN
        ALTER TABLE lessons ADD COLUMN version INTEGER DEFAULT 1 NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lessons' AND column_name = 'schema_version'
    ) THEN
        ALTER TABLE lessons ADD COLUMN schema_version INTEGER DEFAULT 1 NOT NULL;
    END IF;
END $$;

-- ============================================================================
-- 4. NEW TABLES
-- ============================================================================

-- 4a. document_sections
-- Stores chunked text + vector embeddings for semantic search.
-- Each row is a single chunk from a PDF, audio transcript, or image OCR.
CREATE TABLE IF NOT EXISTS document_sections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id       UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,

    -- Content
    content         TEXT NOT NULL,
    embedding       vector(1536),                -- text-embedding-3-small output

    -- Source tracking
    source_type     section_source_type NOT NULL DEFAULT 'pdf',
    source_file_id  TEXT,                        -- FK to the original file in storage

    -- Chunk linking (doubly-linked list for context window expansion)
    chunk_index     INTEGER NOT NULL DEFAULT 0,  -- Order within the source
    prev_id         UUID,                        -- Previous chunk in sequence
    next_id         UUID,                        -- Next chunk in sequence

    -- Rich metadata (page_number, bbox, speaker_id, timestamps, etc.)
    metadata        JSONB DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 4b. processing_queue
-- Async job queue for file processing. Workers pick pending jobs.
-- Implements Dead Letter Queue via 'dead' status after max_attempts.
CREATE TABLE IF NOT EXISTS processing_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id       UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,

    -- Job definition
    job_type        TEXT NOT NULL,                -- 'pdf_extract', 'audio_transcribe', 'image_ocr', 'generate_analysis'
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Lifecycle
    status          processing_status NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    error_message   TEXT,

    -- Locking: worker sets this to prevent concurrent pickup
    locked_at       TIMESTAMPTZ,
    locked_by       TEXT,                        -- Worker instance identifier

    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
    completed_at    TIMESTAMPTZ
);

-- 4c. file_hashes
-- Global deduplication index. Prevents re-processing identical files.
-- SHA-256 hash of file content → existing processing result.
CREATE TABLE IF NOT EXISTS file_hashes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_hash    TEXT NOT NULL,                -- SHA-256 hex digest
    lesson_id       UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    source_type     section_source_type NOT NULL,
    file_path       TEXT,                        -- Path in Supabase Storage
    transcription   TEXT,                        -- Cached Whisper output (audio only)
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 4d. dead_jobs
-- Dead Letter Queue. Jobs that exceeded max_attempts land here for admin review.
CREATE TABLE IF NOT EXISTS dead_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_job_id UUID NOT NULL,
    lesson_id       UUID NOT NULL,
    job_type        TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message   TEXT,
    attempts        INTEGER NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL  -- When it was moved to DLQ
);

-- ============================================================================
-- 5. INDEXES
-- ============================================================================

-- 5a. HNSW vector index for cosine similarity search.
-- lists=100 is optimal for datasets up to ~1M rows.
-- probes should be set at query time (SET ivfflat.probes = 10).
CREATE INDEX IF NOT EXISTS idx_document_sections_embedding
    ON document_sections
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- 5b. Trigram index for BM25-like keyword search (hybrid search component).
CREATE INDEX IF NOT EXISTS idx_document_sections_content_trgm
    ON document_sections
    USING gin (content gin_trgm_ops);

-- 5c. Lookup indexes for common query patterns.
CREATE INDEX IF NOT EXISTS idx_document_sections_lesson_id
    ON document_sections(lesson_id);

CREATE INDEX IF NOT EXISTS idx_document_sections_source_type
    ON document_sections(source_type);

-- 5d. Queue: Workers query by status + created_at (FIFO pickup).
CREATE INDEX IF NOT EXISTS idx_processing_queue_status_created
    ON processing_queue(status, created_at)
    WHERE status = 'pending';

-- 5e. Queue: Prevent duplicate active jobs for the same lesson+type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_job
    ON processing_queue(lesson_id, job_type)
    WHERE status IN ('pending', 'processing');

-- 5f. File hashes: Unique constraint for deduplication lookups.
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_hashes_content_hash
    ON file_hashes(content_hash);

-- 5g. GIN index on document_sections metadata for JSONB queries.
CREATE INDEX IF NOT EXISTS idx_document_sections_metadata
    ON document_sections
    USING gin (metadata);

-- 5h. Lessons: Index on analysis_status for dashboard filtering.
CREATE INDEX IF NOT EXISTS idx_lessons_analysis_status
    ON lessons(analysis_status)
    WHERE analysis_status IS NOT NULL;

-- ============================================================================
-- 6. FUNCTIONS
-- ============================================================================

-- 6a. match_sections: Vector similarity search function.
-- Used by the Focus Extraction step to find book chunks similar to audio chunks.
CREATE OR REPLACE FUNCTION match_sections(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.5,
    match_count     INT DEFAULT 20,
    filter_lesson_id UUID DEFAULT NULL,
    filter_source   section_source_type DEFAULT NULL
)
RETURNS TABLE (
    id              UUID,
    lesson_id       UUID,
    content         TEXT,
    source_type     section_source_type,
    metadata        JSONB,
    similarity      FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ds.id,
        ds.lesson_id,
        ds.content,
        ds.source_type,
        ds.metadata,
        1 - (ds.embedding <=> query_embedding) AS similarity
    FROM document_sections ds
    WHERE
        ds.embedding IS NOT NULL
        AND (filter_lesson_id IS NULL OR ds.lesson_id = filter_lesson_id)
        AND (filter_source IS NULL OR ds.source_type = filter_source)
        AND 1 - (ds.embedding <=> query_embedding) > match_threshold
    ORDER BY ds.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 6b. acquire_job: Atomically pick the next pending job (prevents race conditions).
-- Uses SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent worker pickup.
CREATE OR REPLACE FUNCTION acquire_job(
    worker_id TEXT,
    target_job_type TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    job_id UUID;
BEGIN
    SELECT pq.id INTO job_id
    FROM processing_queue pq
    WHERE pq.status = 'pending'
        AND (target_job_type IS NULL OR pq.job_type = target_job_type)
    ORDER BY pq.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF job_id IS NOT NULL THEN
        UPDATE processing_queue
        SET status = 'processing',
            locked_at = now(),
            locked_by = worker_id,
            attempts = attempts + 1,
            updated_at = now()
        WHERE id = job_id;
    END IF;

    RETURN job_id;
END;
$$;

-- 6c. complete_job: Mark a job as completed.
CREATE OR REPLACE FUNCTION complete_job(target_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    UPDATE processing_queue
    SET status = 'completed',
        completed_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE id = target_job_id;
END;
$$;

-- 6d. fail_job: Mark a job as failed. Moves to DLQ if max_attempts exceeded.
CREATE OR REPLACE FUNCTION fail_job(target_job_id UUID, err_msg TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    job_record RECORD;
BEGIN
    SELECT * INTO job_record FROM processing_queue WHERE id = target_job_id;

    IF job_record.attempts >= job_record.max_attempts THEN
        -- Move to Dead Letter Queue
        INSERT INTO dead_jobs (original_job_id, lesson_id, job_type, payload, error_message, attempts)
        VALUES (job_record.id, job_record.lesson_id, job_record.job_type, job_record.payload, err_msg, job_record.attempts);

        UPDATE processing_queue
        SET status = 'dead',
            error_message = err_msg,
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now()
        WHERE id = target_job_id;
    ELSE
        -- Return to pending for retry
        UPDATE processing_queue
        SET status = 'pending',
            error_message = err_msg,
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now()
        WHERE id = target_job_id;
    END IF;
END;
$$;

-- 6e. updated_at trigger: Auto-update the updated_at column on any row change.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Apply triggers (idempotent: DROP IF EXISTS first)
DROP TRIGGER IF EXISTS trg_document_sections_updated_at ON document_sections;
CREATE TRIGGER trg_document_sections_updated_at
    BEFORE UPDATE ON document_sections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_processing_queue_updated_at ON processing_queue;
CREATE TRIGGER trg_processing_queue_updated_at
    BEFORE UPDATE ON processing_queue
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 7. ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all new tables.
ALTER TABLE document_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_jobs ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users can read their own lesson's sections.
-- (Assumes lesson ownership is validated at the application layer)
DROP POLICY IF EXISTS "Users can view document sections" ON document_sections;
CREATE POLICY "Users can view document sections"
    ON document_sections FOR SELECT
    USING (auth.role() = 'authenticated');

-- Policy: Only service_role (Edge Functions) can insert/update/delete sections.
DROP POLICY IF EXISTS "Service can manage document sections" ON document_sections;
CREATE POLICY "Service can manage document sections"
    ON document_sections FOR ALL
    USING (auth.role() = 'service_role');

-- Policy: Authenticated users can view their queue status.
DROP POLICY IF EXISTS "Users can view processing queue" ON processing_queue;
CREATE POLICY "Users can view processing queue"
    ON processing_queue FOR SELECT
    USING (auth.role() = 'authenticated');

-- Policy: Only service_role can manage the queue.
DROP POLICY IF EXISTS "Service can manage processing queue" ON processing_queue;
CREATE POLICY "Service can manage processing queue"
    ON processing_queue FOR ALL
    USING (auth.role() = 'service_role');

-- Policy: Only service_role can access file_hashes.
DROP POLICY IF EXISTS "Service can manage file hashes" ON file_hashes;
CREATE POLICY "Service can manage file hashes"
    ON file_hashes FOR ALL
    USING (auth.role() = 'service_role');

-- Policy: Only service_role can access dead_jobs.
DROP POLICY IF EXISTS "Service can manage dead jobs" ON dead_jobs;
CREATE POLICY "Service can manage dead jobs"
    ON dead_jobs FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================================================
-- 8. STORAGE BUCKET
-- ============================================================================
-- NOTE: Supabase Storage buckets are created via the Dashboard or API,
-- not via SQL migration. Run this via the Supabase client SDK or Dashboard:
--
--   supabase.storage.createBucket('raw-files', {
--     public: false,
--     fileSizeLimit: 104857600,  // 100MB
--     allowedMimeTypes: [
--       'application/pdf',
--       'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/webm',
--       'image/png', 'image/jpeg', 'image/webp'
--     ]
--   });
--
-- ============================================================================

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
