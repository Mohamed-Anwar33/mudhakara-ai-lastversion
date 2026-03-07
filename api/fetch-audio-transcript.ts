import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
        throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    return createClient(url, serviceKey);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { lessonId } = req.body || {};
        if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });

        const supabase = getSupabaseAdmin();

        // 1. Try to load from storage
        const storagePath = `audio_transcripts/${lessonId}/raw_transcript.txt`;
        try {
            const { data: blob } = await supabase.storage.from('audio_transcripts').download(storagePath);
            if (blob) {
                const text = await blob.text();
                if (text.trim().length > 50) {
                    console.log(`[fetch-audio-transcript] Found existing transcript (${text.length} chars)`);
                    return res.status(200).json({ success: true, transcript: text.trim(), source: 'storage' });
                }
            }
        } catch (_) { }

        // 2. Try document_sections fallback
        const { data: audioSections } = await supabase.from('document_sections')
            .select('content').eq('lesson_id', lessonId)
            .eq('source_type', 'audio').order('section_index', { ascending: true });

        if (audioSections && audioSections.length > 0) {
            const text = audioSections.map((s: any) => s.content).join('\n\n');
            if (text.trim().length > 50) {
                console.log(`[fetch-audio-transcript] Found transcript from document_sections (${text.length} chars)`);
                return res.status(200).json({ success: true, transcript: text.trim(), source: 'document_sections' });
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
            console.log(`[fetch-audio-transcript] Transcript still processing for ${lessonId}`);
            return res.status(200).json({ success: false, status: 'processing', message: 'جاري التفريغ الصوتي، يرجى الانتظار...' });
        }

        console.log(`[fetch-audio-transcript] No transcript found for ${lessonId} and no active jobs.`);
        return res.status(200).json({ success: false, status: 'missing', error: 'لم يتم العثور على تفريغ صوتي.' });

    } catch (error: any) {
        console.error('❌ Audio Transcript Error:', error);
        return res.status(500).json({ error: error.message || 'Failed to fetch transcript' });
    }
}
