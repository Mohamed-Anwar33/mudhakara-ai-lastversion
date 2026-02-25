-- Migration 009: Pipeline Optimization Indexes
-- Improves query performance for the processing queue and document sections

-- Index for faster coverage checks (lecture_id + page)
CREATE INDEX IF NOT EXISTS idx_document_sections_lecture_page 
ON document_sections(lecture_id, page);

-- Index for faster queue polling (status + lock check)
CREATE INDEX IF NOT EXISTS idx_processing_queue_polling 
ON processing_queue(status, locked_by, next_retry_at) 
WHERE status IN ('pending', 'processing');

-- Index for faster job deduplication lookups
CREATE INDEX IF NOT EXISTS idx_processing_queue_dedupe 
ON processing_queue(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Index for lesson-based job lookups (used heavily by orchestrator)
CREATE INDEX IF NOT EXISTS idx_processing_queue_lesson_status 
ON processing_queue(lesson_id, status, job_type);
