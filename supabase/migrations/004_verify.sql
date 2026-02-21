-- ============================================================================
-- Verification: Post-Patch Focus Extraction + Race Fix + Status
-- Run these AFTER deploying the patched code and processing a lesson
-- ============================================================================

-- 1. Verify focus_points exist and are non-empty
SELECT 
    l.id AS lesson_id,
    l.analysis_status,
    jsonb_array_length(l.analysis_result->'focus_points') AS focus_count,
    jsonb_array_length(l.analysis_result->'quiz') AS quiz_count,
    l.analysis_result->'metadata'->>'schemaVersion' AS schema_version,
    l.analysis_result->'metadata'->'focusStats'->>'matchedPdfChunks' AS matched_pdf,
    l.analysis_result->'metadata'->'focusStats'->>'threshold' AS threshold
FROM lessons l
WHERE l.analysis_result IS NOT NULL;

-- 2. Verify focus_points reference valid section IDs
WITH fp_refs AS (
    SELECT 
        l.id AS lesson_id,
        fp->>'title' AS fp_title,
        jsonb_array_elements_text(fp->'evidence'->'pdf_section_ids') AS ref_id
    FROM lessons l,
         jsonb_array_elements(l.analysis_result->'focus_points') AS fp
    WHERE l.analysis_result IS NOT NULL
)
SELECT 
    r.lesson_id,
    r.fp_title,
    r.ref_id,
    CASE WHEN ds.id IS NOT NULL THEN '✅ valid' ELSE '❌ invalid' END AS status
FROM fp_refs r
LEFT JOIN document_sections ds ON ds.id::text = r.ref_id;

-- 3. Verify quiz contains all three types (tf, mcq, essay)
SELECT
    l.id AS lesson_id,
    COUNT(*) FILTER (WHERE q->>'type' = 'tf') AS tf_count,
    COUNT(*) FILTER (WHERE q->>'type' = 'mcq') AS mcq_count,
    COUNT(*) FILTER (WHERE q->>'type' = 'essay') AS essay_count
FROM lessons l,
     jsonb_array_elements(l.analysis_result->'quiz') AS q
WHERE l.analysis_result IS NOT NULL
GROUP BY l.id;

-- 4. Verify status transitions happened correctly
-- Check that no lesson is stuck in 'processing' (should be completed or failed)
SELECT id, analysis_status, updated_at
FROM lessons
WHERE analysis_status = 'processing'
  AND updated_at < now() - interval '5 minutes';

-- 5. Verify race condition fix: no embed/analysis jobs ran prematurely
-- Check for lessons where embeddings are incomplete but analysis was attempted
SELECT 
    l.id,
    l.analysis_status,
    COUNT(ds.id) FILTER (WHERE ds.embedding IS NULL) AS null_embeddings,
    COUNT(ds.id) AS total_sections
FROM lessons l
JOIN document_sections ds ON ds.lesson_id = l.id
WHERE l.analysis_status IN ('completed', 'failed')
GROUP BY l.id
HAVING COUNT(ds.id) FILTER (WHERE ds.embedding IS NULL) > 0;

-- 6. Verify embedding coverage by source type
SELECT 
    ds.lesson_id,
    ds.source_type,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ds.embedding IS NOT NULL) AS embedded
FROM document_sections ds
GROUP BY ds.lesson_id, ds.source_type
ORDER BY ds.lesson_id, ds.source_type;
