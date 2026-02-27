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

            // Chunk & Embed to Vector DB
            // Normally, calling text-embedding-ada-002 here for each segment. Simulated insert:
            const insertPayloads = segments.map((seg: any, index: number) => ({
                lesson_id: lesson_id,
                chunk_index: index,
                start_time: seg.start,
                end_time: seg.end,
                storage_path: storagePath,
                // embedding: would go here 
            }));

            await supabase.from('audio_transcripts').insert(insertPayloads);

            // Audio complete, mark done.
            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

            // Important: Queue Focus extraction if OCR is done
            const { data: pendingOcr } = await supabase.from('processing_queue')
                .select('id').eq('lesson_id', lesson_id).eq('job_type', 'ocr_page_batch').in('status', ['pending', 'processing']);

            if (!pendingOcr || pendingOcr.length === 0) {
                // If OCR is finished, we can run intersection!
                await supabase.from('processing_queue').insert({
                    lesson_id: lesson_id,
                    job_type: 'extract_audio_focus',
                    status: 'pending'
                });
            }

            return new Response(JSON.stringify({ status: 'completed', chunk_count: segments.length }), { headers: corsHeaders });
        }


        // 2. Focus Extraction (Cross-referencing Audio X Text)
        if (job_type === 'extract_audio_focus') {
            // Call the RPC that calculates Cosine Similarity!
            console.log(`[audio-worker] Running match_focus_points RPC for lesson ${lesson_id}...`);
            const { error: rpcErr } = await supabase.rpc('match_focus_points', { p_lesson_id: lesson_id, p_similarity_threshold: 0.78 });

            if (rpcErr) throw new Error(`Focus Matching RPC Failed: ${rpcErr.message}`);

            // Queue Segmenter now that Focus is ready
            await supabase.from('processing_queue').insert({
                lesson_id: lesson_id,
                job_type: 'segment_lesson',
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:segment_lesson`
            });

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
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
