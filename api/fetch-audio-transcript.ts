import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Vercel API Route: POST /api/fetch-audio-transcript
 * 
 * Fetches audio transcript from storage for a given lesson.
 * Body: { lessonId: string }
 */

export const config = {
    maxDuration: 10
};

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error('Missing env vars');
    return createClient(url, serviceKey);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { lessonId } = req.body || {};
        if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });

        const supabase = getSupabaseAdmin();

        // 1. Try to load from audio_transcripts storage
        const paths = [
            { bucket: 'audio_transcripts', path: `${lessonId}/raw_transcript.txt` },
            { bucket: 'ocr', path: `${lessonId}/audio_transcript.txt` },
        ];
        for (const { bucket, path } of paths) {
            try {
                const { data: blob } = await supabase.storage.from(bucket).download(path);
                if (blob) {
                    const text = await blob.text();
                    if (text.trim().length > 50) {
                        return res.json({ success: true, transcript: text.trim(), source: bucket });
                    }
                }
            } catch (_) { }
        }

        // 2. Try document_sections fallback
        const { data: audioSections } = await supabase.from('document_sections')
            .select('content').eq('lesson_id', lessonId)
            .eq('source_type', 'audio').order('section_index', { ascending: true });

        if (audioSections && audioSections.length > 0) {
            const text = audioSections.map((s: any) => s.content).join('\n\n');
            if (text.trim().length > 50) {
                return res.json({ success: true, transcript: text.trim(), source: 'document_sections' });
            }
        }

        // 3. No transcript found — check if it's still processing
        const { data: jobs } = await supabase.from('processing_queue')
            .select('status, job_type')
            .eq('lesson_id', lessonId)
            .in('job_type', ['transcribe_audio', 'extract_audio_focus'])
            .order('created_at', { ascending: false })
            .limit(1);

        if (jobs && jobs.length > 0 && ['pending', 'processing'].includes(jobs[0].status)) {
            return res.json({ success: false, status: 'processing', message: 'جاري التفريغ الصوتي، يرجى الانتظار...' });
        }

        return res.json({ success: false, status: 'missing', error: 'لم يتم العثور على تفريغ صوتي.' });

    } catch (error: any) {
        console.error('[fetch-audio-transcript] Error:', error);
        res.status(500).json({ error: error.message });
    }
}
