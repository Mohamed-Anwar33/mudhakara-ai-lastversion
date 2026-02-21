-- ============================================================================
-- VERIFICATION QUERIES for 001_ai_content_analysis
-- Run these after migration to confirm correctness.
-- Each query should return a non-empty result or expected value.
-- ============================================================================

-- ✅ 1. Confirm pgvector extension is active
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- Expected: 1 row with extname = 'vector'

-- ✅ 2. Confirm pg_trgm extension is active
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';
-- Expected: 1 row with extname = 'pg_trgm'

-- ✅ 3. Confirm all new tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('document_sections', 'processing_queue', 'file_hashes', 'dead_jobs')
ORDER BY table_name;
-- Expected: 4 rows

-- ✅ 4. Confirm lessons table has new columns
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'lessons'
  AND column_name IN ('analysis_result', 'analysis_status', 'version', 'schema_version')
ORDER BY column_name;
-- Expected: 4 rows

-- ✅ 5. Confirm HNSW vector index exists
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'document_sections' AND indexname = 'idx_document_sections_embedding';
-- Expected: 1 row showing HNSW index

-- ✅ 6. Confirm trigram index exists
SELECT indexname FROM pg_indexes
WHERE tablename = 'document_sections' AND indexname = 'idx_document_sections_content_trgm';
-- Expected: 1 row

-- ✅ 7. Confirm unique constraint on active jobs (prevents duplicate processing)
SELECT indexname, indexdef FROM pg_indexes
WHERE indexname = 'idx_processing_queue_active_job';
-- Expected: 1 row with WHERE clause for pending/processing

-- ✅ 8. Confirm unique constraint on file_hashes
SELECT indexname FROM pg_indexes
WHERE indexname = 'idx_file_hashes_content_hash';
-- Expected: 1 row

-- ✅ 9. Confirm ON DELETE CASCADE on document_sections
SELECT
    tc.constraint_name,
    rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
WHERE tc.table_name = 'document_sections'
  AND tc.constraint_type = 'FOREIGN KEY';
-- Expected: delete_rule = 'CASCADE'

-- ✅ 10. Confirm RLS is enabled on all new tables
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('document_sections', 'processing_queue', 'file_hashes', 'dead_jobs');
-- Expected: 4 rows, all with rowsecurity = true

-- ✅ 11. Confirm match_sections function exists
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'match_sections' AND routine_schema = 'public';
-- Expected: 1 row

-- ✅ 12. Confirm acquire_job function exists
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'acquire_job' AND routine_schema = 'public';
-- Expected: 1 row

-- ✅ 13. Confirm fail_job function exists (handles DLQ)
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'fail_job' AND routine_schema = 'public';
-- Expected: 1 row

-- ✅ 14. Confirm updated_at triggers exist
SELECT trigger_name, event_object_table FROM information_schema.triggers
WHERE trigger_name IN ('trg_document_sections_updated_at', 'trg_processing_queue_updated_at');
-- Expected: 2 rows

-- ✅ 15. Functional test: Insert + Vector search round-trip
-- (Run only in dev/staging, not production)
/*
DO $$
DECLARE
    test_lesson_id TEXT := 'test-verify-001';
    test_result RECORD;
BEGIN
    -- Insert a test section with a dummy embedding
    INSERT INTO document_sections (lesson_id, content, embedding, source_type, chunk_index)
    VALUES (test_lesson_id, 'هذا نص تجريبي للتحقق', array_fill(0.1, ARRAY[1536])::vector, 'pdf', 0);

    -- Verify vector search returns it
    SELECT * INTO test_result
    FROM match_sections(
        array_fill(0.1, ARRAY[1536])::vector,
        0.0, 1, test_lesson_id, 'pdf'
    );

    IF test_result.id IS NOT NULL THEN
        RAISE NOTICE '✅ Vector search round-trip: PASSED';
    ELSE
        RAISE EXCEPTION '❌ Vector search round-trip: FAILED';
    END IF;

    -- Cleanup
    DELETE FROM document_sections WHERE lesson_id = test_lesson_id;
END $$;
*/
