import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function uploadStreamToGemini(audioUrl: string, apiKey: string): Promise<string> {
    const headRes = await fetch(audioUrl, { method: 'HEAD' });
    const contentLength = headRes.headers.get('content-length');
    const mimeType = headRes.headers.get('content-type') || 'audio/mp3';

    if (!contentLength) throw new Error('Could not determine content length for streaming');

    const startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
        {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': contentLength,
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ file: { displayName: "audio_upload" } })
        }
    );
    if (!startRes.ok) throw new Error(`Gemini File API start failed: ${startRes.status} ${await startRes.text()}`);

    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL allocated');

    const audioStreamRes = await fetch(audioUrl);
    if (!audioStreamRes.ok || !audioStreamRes.body) throw new Error('Failed to stream audio from Storage');

    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': contentLength,
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: audioStreamRes.body,
        duplex: 'half'
    } as any);

    if (!uploadRes.ok) throw new Error(`Gemini File API upload failed: ${uploadRes.status} ${await uploadRes.text()}`);

    const fileInfo = await uploadRes.json();
    const fileUri = fileInfo.file?.uri;
    if (!fileUri) throw new Error('No file URI returned');

    const fileName2 = fileInfo.file?.name;
    for (let i = 0; i < 150; i++) {
        const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${apiKey}`);
        const status = await s.json();
        if (status.state === 'ACTIVE') return fileUri;
        if (status.state === 'FAILED') throw new Error('File processing failed on Gemini servers');
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('Audio file processing timeout on Gemini');
}

async function transcribeWithGemini(fileUri: string, apiKey: string): Promise<string> {
    const prompt = "أنت خبير في التفريغ الصوتي (Transcription). قم بتفريغ هذا المقطع الصوتي بكل دقة إلى نص عربي واضح ومترابط. اكتب النص بالكامل كما قيل بدون تلخيص، وتأكد من صحة الإملاء والوقفات.";

    // Upgraded to Gemini 1.5 Pro for significantly higher accuracy
    const apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt },
                    { fileData: { fileUri: fileUri, mimeType: "audio/mp3" } }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
            }
        })
    });

    if (!apiRes.ok) {
        throw new Error(`Gemini Transcription Failed: ${await apiRes.text()}`);
    }

    const data = await apiRes.json();
    const resParts = data.candidates?.[0]?.content?.parts || [];
    return resParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    let jobId: string | undefined;
    try {
        const body = await req.json();
        jobId = body.jobId;
        if (!jobId) throw new Error('Missing jobId');

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
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
        // Helper to update UI progress visually using error_message field
        const updateProgress = async (msg: string) => {
            console.log(`[audio-worker-progress] ${msg}`);
            await supabase.from('processing_queue').update({ error_message: msg }).eq('id', jobId);
        };

        // 1. Audio Transcribe Job
        if (job_type === 'transcribe_audio') {
            if (!audioPath) throw new Error('Missing audio_url to process');

            await updateProgress('جاري تحميل المقطع الصوتي من التخزين السحابي...');

            // Bypass memory completely with Signed URLs
            const { data: signedUrlData, error: signErr } = await supabase.storage.from('homework-uploads').createSignedUrl(audioPath, 3600);
            if (signErr || !signedUrlData?.signedUrl) throw new Error(`Failed to get signed URL: ${signErr?.message}`);

            const audioUrl = signedUrlData.signedUrl;

            // --- OOM DEFENSE: Check file size before deciding to use memory-heavy Whisper ---
            const headRes = await fetch(audioUrl, { method: 'HEAD' });
            const contentLengthStr = headRes.headers.get('content-length');
            const fileSizeBytes = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;
            const fileSizeMB = fileSizeBytes / (1024 * 1024);
            console.log(`[audio-worker] Audio file size: ${fileSizeMB.toFixed(2)} MB`);

            let fullTranscript = '';
            let usedWhisper = false;

            // Edge Functions have 50MB RAM limit. Loading > 12MB blob + FormData overhead will crash V8.
            if (openaiKey && fileSizeMB < 12) {
                try {
                    console.log(`[audio-worker] Attempting transcription with OpenAI Whisper...`);
                    await updateProgress('جاري تفريغ الصوت بدقة عالية (OpenAI Whisper)...');

                    // We only load to memory if we use Whisper
                    const audioRes = await fetch(audioUrl);
                    let audioBlob: Blob | null = await audioRes.blob();

                    const formData = new FormData();
                    formData.append('file', audioBlob, 'audio.mp3');
                    formData.append('model', 'whisper-1');
                    formData.append('response_format', 'text'); // Native text response

                    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${openaiKey}` },
                        body: formData
                    });

                    if (whisperRes.ok) {
                        fullTranscript = await whisperRes.text();
                        usedWhisper = true;
                        console.log(`[audio-worker] OpenAI Whisper transcription successful. Length: ${fullTranscript.length}`);
                    } else {
                        const errText = await whisperRes.text();
                        console.warn(`[audio-worker] Whisper API Failed (${whisperRes.status}): ${errText}. Falling back to Gemini...`);
                    }

                    // CRITICAL: Explicitly free V8 isolate memory to prevent OOM
                    audioBlob = null;
                } catch (e: any) {
                    console.warn(`[audio-worker] Whisper request exception: ${e.message}. Falling back to Gemini...`);
                }
            }

            if (!usedWhisper) {
                if (!geminiKey) throw new Error('Missing GEMINI_API_KEY for fallback audio transcription');

                if (fileSizeMB >= 12) {
                    console.log(`[audio-worker] File too large for Whisper (${fileSizeMB.toFixed(2)}MB). Bypassing to Gemini Stream directly to prevent OOM.`);
                }

                console.log(`[audio-worker] Uploading stream to Gemini File API for transcription...`);
                await updateProgress('جاري رفع المقطع المستمر إلى محرك Gemini Pro للملفات الكبيرة (Streaming)...');

                // 1. Upload bypassing local memory (OOM Defense)
                const fileUri = await uploadStreamToGemini(audioUrl, geminiKey);

                console.log(`[audio-worker] Audio uploaded successfully. URI: ${fileUri}. Starting Gemini transcription...`);
                await updateProgress('نجح الرفع. جاري الاستماع للمقطع وتفريغ النصوص (Gemini 1.5 Pro)... هذه العملية قد تستغرق بضع دقائق.');

                // 2. Transcribe Audio natively with Gemini 1.5 Pro (High Accuracy)
                fullTranscript = await transcribeWithGemini(fileUri, geminiKey);
                console.log(`[audio-worker] Gemini Pro transcription successful. Length: ${fullTranscript.length}`);
            }

            if (!fullTranscript || fullTranscript.length < 5) {
                console.warn(`[audio-worker] Transcription returned unusually short text.`);
            }

            await updateProgress('اكتمل التفريغ! جاري حفظ النصوص المفرغة...');
            // Save the raw text to Supabase Storage
            const storagePath = `audio_transcripts/${lesson_id}/raw_transcript.txt`;
            await supabase.storage.from('audio_transcripts').upload(storagePath, fullTranscript, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

            // Since analyze-lesson now uses the LLM Semantic Matcher to dynamically read 
            // this raw_transcript.txt file from the bucket, we do not need to generate
            // vector embeddings or run the cosine similarity RPC anymore.

            console.log(`[audio-worker] Successfully transcribed and saved audio for lesson ${lesson_id}.`);

            // Audio complete, mark done.
            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

            // Trigger the segmentation barrier (in case this is an audio-only lesson, or to notify OCR it's done)
            await supabase.from('processing_queue').upsert({
                lesson_id: lesson_id,
                job_type: 'segment_lesson',
                payload: { ...payload },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:segment_lesson`
            }, { onConflict: 'dedupe_key', ignoreDuplicates: true });

            return new Response(JSON.stringify({ status: 'completed', chunk_count: 1 }), { headers: corsHeaders });
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
