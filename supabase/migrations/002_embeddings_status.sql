-- ============================================================================
-- Migration: 002_embeddings_status
-- Purpose:   Add 'embedded' status to processing_status enum for Phase 4
-- Idempotent: YES — ADD VALUE IF NOT EXISTS is safe to re-run (PG 9.3+)
-- ============================================================================

-- Add 'embedded' as an intermediate status between 'completed' and full analysis.
-- Lifecycle becomes: pending → processing → completed → embedded → (Phase 6: analyzed)
ALTER TYPE processing_status ADD VALUE IF NOT EXISTS 'embedded';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
