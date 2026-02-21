-- ============================================================================
-- Migration: 003_hybrid_search
-- Purpose:   Hybrid retrieval layer (FTS + Vector + RRF) for Arabic+English
-- Author:    AI Systems Architect
-- Date:      2026-02-19
-- Idempotent: YES — All statements use IF NOT EXISTS / OR REPLACE.
-- ============================================================================

-- ============================================================================
-- 1. ARABIC TEXT NORMALIZATION
-- ============================================================================

-- normalize_arabic(text) → text
-- IMMUTABLE so it can be used in generated columns and indexes.
--
-- Normalization rules:
--   1. Remove tatweel (ـ U+0640) — decorative elongation
--   2. Unify alif forms (أ إ آ → ا) — prevents search misses on hamza variants
--   3. Unify ya / alif maqsura (ى → ي) — ى and ي are used interchangeably
--   4. Remove diacritics (harakat U+064B-U+065F, superscript alef U+0670)
--   5. Collapse whitespace
--
-- ta marbuta (ة) is intentionally NOT normalized to ه because:
--   - ة vs ه distinguishes feminine nouns from pronouns (مدرسة ≠ مدرسه)
--   - Normalizing would create false positives in search
--   - The 'simple' config tokenizes on whitespace so ة at word-end is preserved

CREATE OR REPLACE FUNCTION normalize_arabic(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
    SELECT
        -- Step 5: Collapse whitespace
        regexp_replace(
            -- Step 4: Remove diacritics (harakat range U+064B–U+065F + U+0670)
            regexp_replace(
                -- Step 3: Unify ى → ي
                replace(
                    -- Step 2: Unify alif forms → ا
                    replace(replace(replace(
                        -- Step 1: Remove tatweel ـ
                        replace(input, E'\u0640', ''),
                    E'\u0623', E'\u0627'),  -- أ → ا
                    E'\u0625', E'\u0627'),  -- إ → ا
                    E'\u0622', E'\u0627'),  -- آ → ا
                E'\u0649', E'\u064A'),      -- ى → ي
            E'[\u064B-\u065F\u0670]', '', 'g'),
        '\s+', ' ', 'g');
$$;

COMMENT ON FUNCTION normalize_arabic(text) IS 
    'Normalizes Arabic text for consistent full-text search. '
    'Removes tatweel, unifies alif/ya forms, strips diacritics.';

-- ============================================================================
-- 2. FTS COLUMN + GENERATED INDEX
-- ============================================================================

-- Add tsvector column if it doesn't exist.
-- We use a trigger instead of a generated column because we need normalize_arabic()
-- applied before to_tsvector, and generated columns can't chain custom functions
-- with to_tsvector in all PG versions.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'document_sections' AND column_name = 'fts'
    ) THEN
        ALTER TABLE document_sections ADD COLUMN fts tsvector;
    END IF;
END $$;

-- GIN index on fts for fast full-text search
CREATE INDEX IF NOT EXISTS idx_document_sections_fts
    ON document_sections USING GIN (fts);

-- Composite index: lesson_id + fts for scoped FTS queries
CREATE INDEX IF NOT EXISTS idx_document_sections_lesson_fts
    ON document_sections (lesson_id)
    INCLUDE (fts)
    WHERE fts IS NOT NULL;

-- ============================================================================
-- 3. FTS TRIGGER — Auto-update tsvector on INSERT/UPDATE
-- ============================================================================

-- Uses 'simple' config because:
--   - Supabase PG doesn't include an Arabic-specific text search config
--   - 'simple' tokenizes on whitespace/punctuation without language-specific stemming
--   - This is BETTER for Arabic than 'english' which would apply English stemming
--   - Our normalize_arabic() handles the normalization that a stemmer would do
--   - Tradeoff: no Arabic morphological analysis, but with normalized text +
--     trigram fallback from pg_trgm, accuracy is still high

CREATE OR REPLACE FUNCTION document_sections_fts_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.fts := to_tsvector('simple', normalize_arabic(COALESCE(NEW.content, '')));
    RETURN NEW;
END;
$$;

-- Drop and recreate trigger (idempotent)
DROP TRIGGER IF EXISTS trg_document_sections_fts ON document_sections;
CREATE TRIGGER trg_document_sections_fts
    BEFORE INSERT OR UPDATE OF content ON document_sections
    FOR EACH ROW
    EXECUTE FUNCTION document_sections_fts_trigger();

-- Backfill existing rows that have NULL fts
UPDATE document_sections
SET fts = to_tsvector('simple', normalize_arabic(COALESCE(content, '')))
WHERE fts IS NULL;

-- ============================================================================
-- 4. FULL-TEXT SEARCH FUNCTION
-- ============================================================================

-- fts_search: BM25-ish ranking via ts_rank_cd (cover density)
-- ts_rank_cd is more accurate than ts_rank for proximity-aware ranking.
-- Normalization flag 32 = rank / (1 + rank) to normalize to [0,1] range.

CREATE OR REPLACE FUNCTION fts_search(
    p_lesson_id uuid,
    p_query_text text,
    p_top_k integer DEFAULT 10
)
RETURNS TABLE(
    section_id uuid,
    content text,
    fts_score real,
    fts_rank integer
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    normalized_query text;
    tsquery_val tsquery;
BEGIN
    -- Normalize the query the same way we normalize stored content
    normalized_query := normalize_arabic(p_query_text);
    
    -- Build tsquery: split on whitespace, join with & (AND) for precision
    -- plainto_tsquery would use & by default, but we use websearch_to_tsquery
    -- which supports quoted phrases and OR operators
    tsquery_val := websearch_to_tsquery('simple', normalized_query);
    
    -- If query produces empty tsquery, fall back to plainto
    IF tsquery_val IS NULL OR tsquery_val = ''::tsquery THEN
        tsquery_val := plainto_tsquery('simple', normalized_query);
    END IF;
    
    -- If still empty, return no results
    IF tsquery_val IS NULL OR tsquery_val = ''::tsquery THEN
        RETURN;
    END IF;
    
    RETURN QUERY
    SELECT
        ds.id AS section_id,
        ds.content,
        ts_rank_cd(ds.fts, tsquery_val, 32)::real AS fts_score,
        ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(ds.fts, tsquery_val, 32) DESC
        )::integer AS fts_rank
    FROM document_sections ds
    WHERE ds.lesson_id = p_lesson_id
      AND ds.fts IS NOT NULL
      AND ds.fts @@ tsquery_val
    ORDER BY fts_score DESC
    LIMIT p_top_k;
END;
$$;

-- ============================================================================
-- 5. VECTOR SEARCH FUNCTION
-- ============================================================================

-- vector_search: cosine similarity via pgvector <=> operator.
-- Returns similarity (1 - distance) so higher = better.
-- HNSW index is used automatically for ORDER BY embedding <=> query.

CREATE OR REPLACE FUNCTION vector_search(
    p_lesson_id uuid,
    p_query_embedding vector(1536),
    p_top_k integer DEFAULT 10
)
RETURNS TABLE(
    section_id uuid,
    content text,
    vec_score real,
    vec_rank integer
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ds.id AS section_id,
        ds.content,
        (1 - (ds.embedding <=> p_query_embedding))::real AS vec_score,
        ROW_NUMBER() OVER (
            ORDER BY ds.embedding <=> p_query_embedding ASC
        )::integer AS vec_rank
    FROM document_sections ds
    WHERE ds.lesson_id = p_lesson_id
      AND ds.embedding IS NOT NULL
    ORDER BY ds.embedding <=> p_query_embedding ASC
    LIMIT p_top_k;
END;
$$;

-- ============================================================================
-- 6. HYBRID SEARCH WITH RECIPROCAL RANK FUSION (RRF)
-- ============================================================================

-- RRF formula: score(d) = Σ 1/(k + rank_i(d))
-- where k = 60 (standard constant that dampens high-rank dominance)
--
-- Why RRF over linear combination?
--   - RRF is rank-based, not score-based → immune to score distribution differences
--   - FTS scores (ts_rank_cd) and cosine similarity have completely different scales
--   - RRF handles missing results gracefully (if a doc appears in only one list)
--
-- Graceful degradation:
--   - If query_text is NULL/empty → RRF uses only vector scores
--   - If query_embedding is NULL → RRF uses only FTS scores
--   - Both NULL → returns empty

CREATE OR REPLACE FUNCTION hybrid_search_rrf(
    p_lesson_id uuid,
    p_query_text text,
    p_query_embedding vector(1536) DEFAULT NULL,
    p_top_k integer DEFAULT 10,
    p_rrf_k integer DEFAULT 60
)
RETURNS TABLE(
    section_id uuid,
    content text,
    final_score real,
    fts_rank integer,
    vec_rank integer,
    fts_score real,
    vec_score real
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    has_text boolean;
    has_embedding boolean;
    -- Fetch more candidates from each modality than final top_k
    -- to improve fusion quality
    candidate_k integer;
BEGIN
    has_text := (p_query_text IS NOT NULL AND trim(p_query_text) != '');
    has_embedding := (p_query_embedding IS NOT NULL);
    
    -- No inputs → return empty
    IF NOT has_text AND NOT has_embedding THEN
        RETURN;
    END IF;
    
    -- Fetch 2x candidates from each source to improve RRF coverage
    candidate_k := p_top_k * 2;
    
    RETURN QUERY
    WITH
    -- FTS results (empty if no query text)
    fts AS (
        SELECT f.section_id, f.content, f.fts_score, f.fts_rank
        FROM fts_search(p_lesson_id, p_query_text, candidate_k) f
        WHERE has_text
    ),
    -- Vector results (empty if no embedding)
    vec AS (
        SELECT v.section_id, v.content, v.vec_score, v.vec_rank
        FROM vector_search(p_lesson_id, p_query_embedding, candidate_k) v
        WHERE has_embedding
    ),
    -- Union all candidate section_ids
    all_candidates AS (
        SELECT f.section_id, f.content FROM fts f
        UNION
        SELECT v.section_id, v.content FROM vec v
    ),
    -- Compute RRF scores
    scored AS (
        SELECT
            ac.section_id,
            ac.content,
            -- RRF: 1/(k + rank) for each modality, 0 if not present
            (
                COALESCE(1.0 / (p_rrf_k + f.fts_rank), 0) +
                COALESCE(1.0 / (p_rrf_k + v.vec_rank), 0)
            )::real AS final_score,
            f.fts_rank,
            v.vec_rank,
            COALESCE(f.fts_score, 0)::real AS fts_score,
            COALESCE(v.vec_score, 0)::real AS vec_score
        FROM all_candidates ac
        LEFT JOIN fts f ON f.section_id = ac.section_id
        LEFT JOIN vec v ON v.section_id = ac.section_id
    )
    SELECT 
        s.section_id,
        s.content,
        s.final_score,
        s.fts_rank,
        s.vec_rank,
        s.fts_score,
        s.vec_score
    FROM scored s
    ORDER BY s.final_score DESC
    LIMIT p_top_k;
END;
$$;

-- ============================================================================
-- 7. PERMISSIONS
-- ============================================================================

-- Authenticated users can call search functions (read-only)
GRANT EXECUTE ON FUNCTION normalize_arabic(text) TO authenticated;
GRANT EXECUTE ON FUNCTION fts_search(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION vector_search(uuid, vector, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION hybrid_search_rrf(uuid, text, vector, integer, integer) TO authenticated;

-- Service role gets full access
GRANT EXECUTE ON FUNCTION normalize_arabic(text) TO service_role;
GRANT EXECUTE ON FUNCTION fts_search(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION vector_search(uuid, vector, integer) TO service_role;
GRANT EXECUTE ON FUNCTION hybrid_search_rrf(uuid, text, vector, integer, integer) TO service_role;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
