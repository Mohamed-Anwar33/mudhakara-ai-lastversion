-- Phase 1: Full-Book Lecture-Aware Architecture Migrations

-- 1. Add dedupe_key (UNIQUE) to processing_queue
ALTER TABLE processing_queue ADD COLUMN IF NOT EXISTS dedupe_key TEXT UNIQUE;

-- 2. Create lecture_segments table
CREATE TABLE IF NOT EXISTS lecture_segments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    page_from INTEGER NOT NULL,
    page_to INTEGER NOT NULL,
    confidence FLOAT DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lecture_segments_lesson_id ON lecture_segments(lesson_id);

-- 3. Update document_sections
ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS lecture_id UUID REFERENCES lecture_segments(id) ON DELETE SET NULL;
ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS page INTEGER;

CREATE INDEX IF NOT EXISTS idx_document_sections_lecture_id ON document_sections(lecture_id);

-- 4. Create lecture_analysis table
CREATE TABLE IF NOT EXISTS lecture_analysis (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lecture_id UUID REFERENCES lecture_segments(id) ON DELETE CASCADE UNIQUE,
    summary TEXT,
    detailed_explanation TEXT,
    key_points JSONB DEFAULT '[]'::jsonb,
    examples JSONB DEFAULT '[]'::jsonb,
    quiz JSONB DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Create book_analysis table
CREATE TABLE IF NOT EXISTS book_analysis (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE UNIQUE,
    overall_summary TEXT,
    index_map JSONB DEFAULT '{}'::jsonb,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS Policies For New Tables

-- Lecture Segments
ALTER TABLE lecture_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public profiles are viewable by everyone for segments" ON lecture_segments FOR SELECT USING (true);
CREATE POLICY "Users can insert segments" ON lecture_segments FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update segments" ON lecture_segments FOR UPDATE USING (true);

-- Lecture Analysis
ALTER TABLE lecture_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public profiles are viewable by everyone for lecture analysis" ON lecture_analysis FOR SELECT USING (true);
CREATE POLICY "Users can insert lecture analysis" ON lecture_analysis FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update lecture analysis" ON lecture_analysis FOR UPDATE USING (true);

-- Book Analysis
ALTER TABLE book_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public profiles are viewable by everyone for book analysis" ON book_analysis FOR SELECT USING (true);
CREATE POLICY "Users can insert book analysis" ON book_analysis FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update book analysis" ON book_analysis FOR UPDATE USING (true);

-- Drop old constraints on processing_queue if they are getting loose
-- No destructive drops here, just ensuring dedupe_key enforces single jobs
