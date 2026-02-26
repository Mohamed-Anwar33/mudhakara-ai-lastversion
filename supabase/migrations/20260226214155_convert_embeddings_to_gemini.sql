-- ============================================================================
-- Migration: 012_convert_embeddings_to_gemini
-- Purpose:   Convert vector column from 1536 dims (OpenAI) to 768 dims (Gemini)
-- ============================================================================

-- 1. Drop existing functions that depend on vector(1536)
DROP FUNCTION IF EXISTS vector_search;
DROP FUNCTION IF EXISTS hybrid_search_rrf;
DROP FUNCTION IF EXISTS match_sections;

-- 2. Drop the existing HNSW index
DROP INDEX IF EXISTS document_sections_embedding_idx;

-- 3. Alter the embedding column to 768 dimensions. 
-- Existing 1536-dim embeddings are incompatible and must be cleared (set to NULL).
ALTER TABLE document_sections 
ALTER COLUMN embedding TYPE vector(768) USING NULL;

-- 4. Recreate the HNSW index for the 768-dim column
CREATE INDEX IF NOT EXISTS document_sections_embedding_idx
    ON document_sections USING hnsw (embedding vector_cosine_ops);

-- 5. Recreate vector_search function for 768 dims
CREATE OR REPLACE FUNCTION vector_search(
    p_lesson_id uuid,
    p_query_embedding vector(768),
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

-- 6. Recreate hybrid_search_rrf function for 768 dims
CREATE OR REPLACE FUNCTION hybrid_search_rrf(
    p_lesson_id uuid,
    p_query_text text,
    p_query_embedding vector(768) DEFAULT NULL,
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
    candidate_k integer;
BEGIN
    has_text := (p_query_text IS NOT NULL AND trim(p_query_text) != '');
    has_embedding := (p_query_embedding IS NOT NULL);
    
    IF NOT has_text AND NOT has_embedding THEN
        RETURN;
    END IF;
    
    candidate_k := p_top_k * 2;
    
    RETURN QUERY
    WITH
    fts AS (
        SELECT f.section_id, f.content, f.fts_score, f.fts_rank
        FROM fts_search(p_lesson_id, p_query_text, candidate_k) f
        WHERE has_text
    ),
    vec AS (
        SELECT v.section_id, v.content, v.vec_score, v.vec_rank
        FROM vector_search(p_lesson_id, p_query_embedding, candidate_k) v
        WHERE has_embedding
    ),
    all_candidates AS (
        SELECT f.section_id, f.content FROM fts f
        UNION
        SELECT v.section_id, v.content FROM vec v
    ),
    scored AS (
        SELECT
            ac.section_id,
            ac.content,
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

-- 7. Recreate match_sections function for 768 dims
CREATE OR REPLACE FUNCTION match_sections(
    query_embedding vector(768),
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

-- 8. Grant permissions
GRANT EXECUTE ON FUNCTION vector_search(uuid, vector, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION hybrid_search_rrf(uuid, text, vector, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_sections(vector, FLOAT, INT, UUID, section_source_type) TO authenticated, service_role;
