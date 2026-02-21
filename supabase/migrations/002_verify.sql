-- ============================================================================
-- VERIFICATION QUERIES for Phase 4: Embeddings
-- Run after deploying 002_embeddings_status.sql and processing test files.
-- All queries are self-contained — no manual ID replacement needed.
-- ============================================================================

-- 1. Confirm 'embedded' was added to the enum
SELECT enumlabel 
FROM pg_enum 
WHERE enumtypid = 'processing_status'::regtype 
ORDER BY enumsortorder;
-- Expected: pending, processing, completed, failed, dead, embedded

-- 2. Count total vs embedded sections — grouped by lesson
SELECT
    lesson_id,
    COUNT(*) AS total_sections,
    COUNT(embedding) AS embedded_sections,
    COUNT(*) - COUNT(embedding) AS missing_embeddings,
    CASE 
        WHEN COUNT(*) = COUNT(embedding) THEN '✅ ALL EMBEDDED'
        ELSE '⚠️ INCOMPLETE'
    END AS status
FROM document_sections
GROUP BY lesson_id
ORDER BY total_sections DESC;

-- 3. Validate embedding dimensions (all should be 1536)
SELECT 
    id,
    vector_dims(embedding) AS dims,
    CASE 
        WHEN vector_dims(embedding) = 1536 THEN '✅'
        ELSE '❌ WRONG DIMENSION'
    END AS valid
FROM document_sections
WHERE embedding IS NOT NULL
LIMIT 10;

-- 4. Check for zero vectors (should return 0 rows)
SELECT id
FROM document_sections
WHERE embedding IS NOT NULL 
  AND embedding = ARRAY_FILL(0, ARRAY[1536])::vector;
-- Expected: 0 rows

-- 5. Verify lesson status transitioned to 'embedded'
SELECT id, title, analysis_status
FROM lessons
WHERE analysis_status = 'embedded';

-- 6. Check embed_sections jobs in the queue
SELECT 
    id, lesson_id, job_type, status, attempts, error_message, 
    created_at, completed_at
FROM processing_queue
WHERE job_type = 'embed_sections'
ORDER BY created_at DESC
LIMIT 10;

-- 7. Check for any dead embedding jobs (moved to DLQ)
SELECT id, lesson_id, job_type, error_message, created_at
FROM dead_jobs
WHERE job_type = 'embed_sections';
-- Expected: 0 rows (if all went well)

-- 8. EXPLAIN ANALYZE: HNSW index usage (uses first real lesson_id)
-- Run this separately after data exists:
/*
EXPLAIN ANALYZE
SELECT id, content, 1 - (embedding <=> embedding) AS similarity
FROM document_sections
WHERE embedding IS NOT NULL
ORDER BY embedding <=> (SELECT embedding FROM document_sections WHERE embedding IS NOT NULL LIMIT 1)
LIMIT 5;
*/
-- Expected: Should show "Index Scan using idx_document_sections_embedding"
