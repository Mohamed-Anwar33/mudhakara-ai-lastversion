-- Fix for PGRST203 (Ambiguous Function Call)
-- Drops the old 'acquire_job(worker_id TEXT, target_job_type TEXT)' 
-- so that the new V2 'acquire_job(worker_id TEXT)' is the only one used securely without overloading conflicts.

DROP FUNCTION IF EXISTS public.acquire_job(text, text);
