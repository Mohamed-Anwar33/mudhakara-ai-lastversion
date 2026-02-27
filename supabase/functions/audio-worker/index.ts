import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    let jobId: string | undefined;
    try {
        const body = await req.json();
        jobId = body.jobId;
        if (!jobId) throw new Error('Missing jobId');

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: job, error: jobError } = await supabase
            .from('processing_queue')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) throw new Error('Job not found');

        const { job_type, payload, lesson_id } = job;
        const audioPath = payload.audio_url || payload.file_path; // From storage pointer

        console.log(`[audio-worker] Executing ${job_type} for lesson ${lesson_id}`);

        // 1. Audio Transcribe Job
        if (job_type === 'transcribe_audio') {
            if (!audioPath) throw new Error('Missing audio_url to process');

            // Download file from Storage to memory (Assuming < 25MB limits handled by File Upload API pre-worker)
            const { data: audioBlob, error: downloadErr } = await supabase.storage.from('homework-uploads').download(audioPath);
            if (downloadErr || !audioBlob) throw new Error(`Failed to download audio: ${downloadErr?.message}`);

            const formData = new FormData();
            formData.append('file', audioBlob, 'audio.mp3');
            formData.append('model', 'whisper-1');
            formData.append('response_format', 'verbose_json'); // Need timestamps for matching Focus!

            console.log(`[audio-worker] Sending ${audioBlob.size} bytes to OpenAI Whisper API...`);

            const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${openaiKey}` },
                body: formData
            });

            if (!whisperRes.ok) {
                const textErr = await whisperRes.text();
                throw new Error(`Whisper API Failed: ${whisperRes.status} - ${textErr}`);
            }

            const whisperData = await whisperRes.json();
            const fullTranscript = whisperData.text || '';
            const segments = whisperData.segments || [];

            // Save the raw text to Supabase Storage
            const storagePath = `audio_transcripts/${lesson_id}/raw_transcript.txt`;
            await supabase.storage.from('audio_transcripts').upload(storagePath, fullTranscript, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

            // Since analyze-lesson now uses the LLM Semantic Matcher to dynamically read 
            // this raw_transcript.txt file from the bucket, we do not need to generate
            // vector embeddings or run the cosine similarity RPC anymore.

            console.log(`[audio-worker] Successfully transcribed and saved audio for lesson ${lesson_id}.`);

            // Audio complete, mark done.
            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

            // We no longer trigger 'extract_audio_focus'
            // The pipeline will naturally proceed to segment_lesson and analyze_lecture

            return new Response(JSON.stringify({ status: 'completed', chunk_count: segments.length }), { headers: corsHeaders });
        }

        throw new Error(`Unhandled job type: ${job_type}`);

    } catch (error: any) {
        console.error('[audio-worker] Error:', error);
        if (req.method !== 'OPTIONS') {
            try {
                if (jobId) {
                    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    await supabase.from('processing_queue').update({
                        status: 'failed',
                        error_message: error.message || 'Unknown Audio Worker Error',
                        locked_by: null,
                        locked_at: null
                    }).eq('id', jobId);
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
