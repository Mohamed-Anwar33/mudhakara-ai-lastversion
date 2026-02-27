-- Migration: 010_ai_pipeline_v2_core.sql
-- Description: Core schema updates for the AI Pipeline V2 (Map-Reduce, Audio Focus, Page-level tracking)

-- 1. Update `lessons` table for UI Stage mapping and Audio
ALTER TABLE lessons 
ADD COLUMN IF NOT EXISTS pipeline_stage TEXT DEFAULT 'uploading',
ADD COLUMN IF NOT EXISTS audio_url TEXT;

-- 2. Page-Level Tracking Table (New)
CREATE TABLE IF NOT EXISTS lesson_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
  page_number INT,
  storage_path TEXT, -- Pointer to OCR text in Supabase Storage
  ocr_confidence FLOAT,
  char_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, success, failed
  retry_count INT DEFAULT 0,
  UNIQUE(lesson_id, page_number)
);

-- 3. Audio Transcript Tracking Table (New)
CREATE TABLE IF NOT EXISTS audio_transcripts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
  chunk_index INT,
  start_time FLOAT,
  end_time FLOAT,
  storage_path TEXT,
  embedding VECTOR(1536),
  status TEXT DEFAULT 'pending'
);

-- 4. Document Embeddings / Focus Extraction (Update/New)
CREATE TABLE IF NOT EXISTS document_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
  page_number INT,
  storage_path TEXT,
  embedding VECTOR(1536),
  is_focus_point BOOLEAN DEFAULT FALSE,
  similarity_score FLOAT DEFAULT 0.0
);

-- 5. Segmented Lectures (New/Update)
-- If segment table exists, we add the storage pointers
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'segmented_lectures') THEN
        CREATE TABLE segmented_lectures (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
          title TEXT,
          start_page INT,
          end_page INT,
          summary_storage_path TEXT,
          quiz_storage_path TEXT,
          char_count INT DEFAULT 0,
          status TEXT DEFAULT 'pending'
        );
    ELSE
        -- Add missing columns if it exists from older architecture
        ALTER TABLE segmented_lectures 
        ADD COLUMN IF NOT EXISTS summary_storage_path TEXT,
        ADD COLUMN IF NOT EXISTS quiz_storage_path TEXT,
        ADD COLUMN IF NOT EXISTS char_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    END IF;
END $$;

-- 6. Processing Queue Index (Optimization)
-- Help the acquire_job RPC find pending jobs instantly
CREATE INDEX IF NOT EXISTS idx_processing_queue_fetch 
ON processing_queue (status, locked_at) 
WHERE status = 'pending';

-- 7. Robust Locking RPC (Idempotent & Safe)
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
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING id INTO claimed_id;
  
  RETURN claimed_id;
END;
$$ LANGUAGE plpgsql;

-- 8. Efficient Barrier Check RPC
CREATE OR REPLACE FUNCTION check_all_pages_completed(p_lesson_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  uncompleted_count INT;
BEGIN
  SELECT COUNT(*) INTO uncompleted_count
  FROM lesson_pages
  WHERE lesson_id = p_lesson_id AND status != 'success';
  
  RETURN uncompleted_count = 0;
END;
$$ LANGUAGE plpgsql;

-- 9. Match Focus Points RPC (Vector Similarity)
CREATE OR REPLACE FUNCTION match_focus_points(p_lesson_id UUID, p_similarity_threshold FLOAT DEFAULT 0.78)
RETURNS VOID AS $$
BEGIN
  UPDATE document_embeddings de
  SET 
    is_focus_point = TRUE,
    similarity_score = (
      SELECT MAX(1 - (de.embedding <=> at.embedding))
      FROM audio_transcripts at
      WHERE at.lesson_id = p_lesson_id
    )
  WHERE de.lesson_id = p_lesson_id
    AND (
      SELECT MAX(1 - (de.embedding <=> at.embedding))
      FROM audio_transcripts at
      WHERE at.lesson_id = p_lesson_id
    ) >= p_similarity_threshold;
END;
$$ LANGUAGE plpgsql;
