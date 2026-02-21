-- ============================================================================
-- VERIFICATION QUERIES for Phase 5: Hybrid Search
-- Run after deploying 003_hybrid_search.sql.
-- All queries are self-contained — no manual ID replacement needed.
-- ============================================================================

-- ============================================================================
-- A. STRUCTURAL CHECKS
-- ============================================================================

-- 1. Confirm normalize_arabic function exists
SELECT proname, provolatile, proparallel
FROM pg_proc
WHERE proname = 'normalize_arabic';
-- Expected: normalize_arabic | i (immutable) | s (safe)

-- 2. Confirm fts column exists
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'document_sections' AND column_name = 'fts';
-- Expected: fts | tsvector

-- 3. Confirm GIN index on fts
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'document_sections' AND indexname LIKE '%fts%';
-- Expected: idx_document_sections_fts, idx_document_sections_lesson_fts

-- 4. Confirm trigger exists
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE trigger_name = 'trg_document_sections_fts'
  AND event_object_table = 'document_sections';
-- Expected: trg_document_sections_fts | INSERT/UPDATE | BEFORE

-- 5. Confirm all search functions exist
SELECT proname
FROM pg_proc
WHERE proname IN ('fts_search', 'vector_search', 'hybrid_search_rrf')
ORDER BY proname;
-- Expected: 3 rows

-- ============================================================================
-- B. NORMALIZATION CORRECTNESS
-- ============================================================================

-- 6. Test normalize_arabic with various inputs
SELECT
    normalize_arabic('بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ') AS stripped_harakat,
    normalize_arabic('أحمد إبراهيم آمن') AS unified_alif,
    normalize_arabic('مصطفى يحيى') AS unified_ya,
    normalize_arabic('مـــدرســـة') AS removed_tatweel;
-- Expected:
--   stripped_harakat: بسم الله الرحمن الرحيم
--   unified_alif:    احمد ابراهيم امن
--   unified_ya:      مصطفي يحيي
--   removed_tatweel: مدرسة

-- ============================================================================
-- C. FTS BACKFILL CHECK
-- ============================================================================

-- 7. Count sections with/without fts populated
SELECT
    COUNT(*) AS total,
    COUNT(fts) AS has_fts,
    COUNT(*) - COUNT(fts) AS missing_fts
FROM document_sections;
-- Expected: missing_fts = 0

-- ============================================================================
-- D. SEARCH FUNCTION TESTS (using real data)
-- ============================================================================

-- 8. FTS search test — uses first lesson that has sections
SELECT * FROM fts_search(
    (SELECT lesson_id FROM document_sections LIMIT 1),
    (SELECT split_part(content, ' ', 1) FROM document_sections LIMIT 1),
    5
);
-- Expected: 1+ rows with fts_score > 0

-- 9. Vector search test — uses an existing embedding as query
SELECT * FROM vector_search(
    (SELECT lesson_id FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    (SELECT embedding FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    5
);
-- Expected: 1+ rows with vec_score close to 1.0 (self-match)

-- 10. Hybrid search RRF test — both modalities
SELECT * FROM hybrid_search_rrf(
    (SELECT lesson_id FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    (SELECT split_part(content, ' ', 1) FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    (SELECT embedding FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    5,
    60
);
-- Expected: 1+ rows with final_score > 0, both fts_rank and vec_rank populated

-- 11. Graceful degradation: text-only (no embedding)
SELECT * FROM hybrid_search_rrf(
    (SELECT lesson_id FROM document_sections LIMIT 1),
    (SELECT split_part(content, ' ', 1) FROM document_sections LIMIT 1),
    NULL,
    5,
    60
);
-- Expected: results from FTS only, vec_rank IS NULL

-- 12. Graceful degradation: embedding-only (empty text)
SELECT * FROM hybrid_search_rrf(
    (SELECT lesson_id FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    '',
    (SELECT embedding FROM document_sections WHERE embedding IS NOT NULL LIMIT 1),
    5,
    60
);
-- Expected: results from vector only, fts_rank IS NULL

-- ============================================================================
-- E. INDEX USAGE (EXPLAIN ANALYZE)
-- ============================================================================

-- 13. FTS uses GIN index
EXPLAIN ANALYZE
SELECT id, content, ts_rank_cd(fts, plainto_tsquery('simple', 'test'), 32)
FROM document_sections
WHERE fts @@ plainto_tsquery('simple', 'test')
LIMIT 5;
-- Expected: Bitmap Index Scan on idx_document_sections_fts

-- 14. Vector search uses HNSW index (requires real embedding)
/*
EXPLAIN ANALYZE
SELECT id, content, embedding <=> (SELECT embedding FROM document_sections WHERE embedding IS NOT NULL LIMIT 1)
FROM document_sections
WHERE embedding IS NOT NULL
ORDER BY embedding <=> (SELECT embedding FROM document_sections WHERE embedding IS NOT NULL LIMIT 1)
LIMIT 5;
-- Expected: Index Scan using idx_document_sections_embedding
*/
