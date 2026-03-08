import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── Stage 1 Helper: Upload audio stream to Gemini File API ───
// Returns { fileUri, fileName } WITHOUT polling — polling happens in Stage 2
async function uploadStreamToGemini(audioUrl: string, apiKey: string): Promise<{ fileUri: string; fileName: string }> {
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
    const fileName = fileInfo.file?.name; // e.g. "files/abc123"
    if (!fileUri || !fileName) throw new Error('No file URI/name returned from Gemini');

    return { fileUri, fileName };
}

// ─── Stage 2 Helper: Check if Gemini file is ready (single check, no loop!) ───
async function checkGeminiFileStatus(fileName: string, apiKey: string): Promise<'ACTIVE' | 'PROCESSING' | 'FAILED'> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
    if (!res.ok) {
        // Treat 500/502/503 as transient — Gemini is still processing, retry later
        if (res.status >= 500) {
            console.warn(`[audio-worker] Gemini status check returned ${res.status} — treating as PROCESSING (transient).`);
            return 'PROCESSING';
        }
        throw new Error(`Gemini file status check failed: ${res.status}`);
    }
    const status = await res.json();
    if (status.state === 'ACTIVE') return 'ACTIVE';
    if (status.state === 'FAILED') return 'FAILED';
    return 'PROCESSING';
}

// ─── Stage 3 Helper: Transcribe with Gemini using file URI ───
async function transcribeWithGemini(fileUri: string, apiKey: string): Promise<string> {
    const prompt = "أنت خبير في التفريغ الصوتي (Transcription). قم بتفريغ هذا المقطع الصوتي بكل دقة إلى نص عربي واضح ومترابط. اكتب النص بالكامل كما قيل بدون تلخيص، وتأكد من صحة الإملاء والوقفات.";

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
        const audioPath = payload.audio_url || payload.file_path;

        // ─── Determine Stage ───
        const stage = payload.stage || 'upload'; // Default = first call = upload stage

        console.log(`[audio-worker] Executing ${job_type} | stage: ${stage} for lesson ${lesson_id}`);

        const updateProgress = async (msg: string) => {
            console.log(`[audio-worker-progress] ${msg}`);
            await supabase.from('processing_queue').update({ error_message: msg }).eq('id', jobId);
        };

        if (job_type === 'transcribe_audio') {
            if (!audioPath) throw new Error('Missing audio_url to process');

            // ╔══════════════════════════════════════════════╗
            // ║   STAGE 1: UPLOAD — Upload file to Gemini   ║
            // ╚══════════════════════════════════════════════╝
            if (stage === 'upload') {
                await updateProgress('جاري تحميل المقطع الصوتي من التخزين السحابي...');

                const { data: signedUrlData, error: signErr } = await supabase.storage.from('homework-uploads').createSignedUrl(audioPath, 3600);
                if (signErr || !signedUrlData?.signedUrl) throw new Error(`Failed to get signed URL: ${signErr?.message}`);
                const audioUrl = signedUrlData.signedUrl;

                // Check file size
                const headRes = await fetch(audioUrl, { method: 'HEAD' });
                const contentLengthStr = headRes.headers.get('content-length');
                const fileSizeBytes = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;
                const fileSizeMB = fileSizeBytes / (1024 * 1024);
                console.log(`[audio-worker] Audio file size: ${fileSizeMB.toFixed(2)} MB`);

                let fullTranscript = '';
                let whisperDone = false;

                // Try Whisper for small files (< 12MB)
                if (openaiKey && fileSizeMB < 12) {
                    try {
                        console.log(`[audio-worker] Attempting transcription with OpenAI Whisper...`);
                        await updateProgress('جاري تفريغ الصوت بدقة عالية (OpenAI Whisper)...');

                        const audioRes = await fetch(audioUrl);
                        let audioBlob: Blob | null = await audioRes.blob();

                        const formData = new FormData();
                        formData.append('file', audioBlob, 'audio.mp3');
                        formData.append('model', 'whisper-1');
                        formData.append('response_format', 'text');

                        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${openaiKey}` },
                            body: formData
                        });

                        if (whisperRes.ok) {
                            fullTranscript = await whisperRes.text();
                            whisperDone = true;
                            console.log(`[audio-worker] OpenAI Whisper transcription successful. Length: ${fullTranscript.length}`);
                        } else {
                            const errText = await whisperRes.text();
                            console.warn(`[audio-worker] Whisper API Failed (${whisperRes.status}): ${errText}. Falling back to Gemini...`);
                        }
                        audioBlob = null;
                    } catch (e: any) {
                        console.warn(`[audio-worker] Whisper request exception: ${e.message}. Falling back to Gemini...`);
                    }
                }

                // If Whisper succeeded → save and complete immediately
                if (whisperDone && fullTranscript) {
                    await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                    return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
                }

                // Whisper not used or failed → Upload to Gemini
                if (!geminiKey) throw new Error('Missing GEMINI_API_KEY for fallback audio transcription');

                console.log(`[audio-worker] File too large for Whisper (${fileSizeMB.toFixed(2)}MB). Bypassing to Gemini Stream directly to prevent OOM.`);
                console.log(`[audio-worker] Uploading stream to Gemini File API for transcription...`);
                await updateProgress('جاري رفع المقطع المستمر إلى محرك Gemini Pro للملفات الكبيرة (Streaming)...');

                const { fileUri, fileName } = await uploadStreamToGemini(audioUrl, geminiKey);
                console.log(`[audio-worker] Upload complete. URI: ${fileUri}, Name: ${fileName}. Transitioning to polling stage.`);

                // ── Persist state and re-queue for polling ──
                const nextRetry = new Date(Date.now() + 15 * 1000).toISOString();
                await supabase.from('processing_queue').update({
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: nextRetry,
                    attempt_count: 0,
                    error_message: 'جاري انتظار معالجة الملف الصوتي على سيرفرات Gemini...',
                    payload: {
                        ...payload,
                        stage: 'polling_gemini',
                        gemini_file_uri: fileUri,
                        gemini_file_name: fileName,
                        poll_count: 0
                    }
                }).eq('id', jobId);

                return new Response(JSON.stringify({ status: 'staged', next_stage: 'polling_gemini' }), { headers: corsHeaders });
            }

            // ╔══════════════════════════════════════════════════════╗
            // ║   STAGE 2: POLLING — Wait for Gemini to process     ║
            // ╚══════════════════════════════════════════════════════╝
            if (stage === 'polling_gemini') {
                const fileName = payload.gemini_file_name;
                const fileUri = payload.gemini_file_uri;
                const pollCount = payload.poll_count || 0;

                if (!fileName || !fileUri) throw new Error('Missing gemini_file_name/uri in payload for polling stage');

                await updateProgress('جاري استخراج النصوص من الريكورد، يرجى الانتظار (Gemini 1.5 Pro)...');

                console.log(`[audio-worker] Polling Gemini file status: ${fileName} (poll #${pollCount})`);
                const fileStatus = await checkGeminiFileStatus(fileName, geminiKey);

                if (fileStatus === 'ACTIVE') {
                    console.log(`[audio-worker] Gemini file ${fileName} is ACTIVE! Transitioning to transcribe stage.`);

                    const nextRetry = new Date(Date.now() + 2 * 1000).toISOString();
                    await supabase.from('processing_queue').update({
                        status: 'pending',
                        locked_by: null,
                        locked_at: null,
                        next_retry_at: nextRetry,
                        attempt_count: 0,
                        error_message: 'نجح الرفع. جاري بدء تفريغ النصوص...',
                        payload: {
                            ...payload,
                            stage: 'transcribe',
                            poll_count: pollCount + 1
                        }
                    }).eq('id', jobId);

                    return new Response(JSON.stringify({ status: 'staged', next_stage: 'transcribe' }), { headers: corsHeaders });
                }

                if (fileStatus === 'FAILED') {
                    throw new Error('Gemini file processing FAILED on their servers.');
                }

                // Still PROCESSING — re-queue with backoff
                if (pollCount >= 60) {
                    // 60 polls × ~15s = ~15 minutes max wait
                    throw new Error(`Gemini file processing timeout after ${pollCount} polls.`);
                }

                console.log(`[audio-worker] Gemini still processing file ${fileName}... re-queuing (poll #${pollCount}).`);
                const backoffSec = Math.min(10 + pollCount * 2, 30); // 10s → 30s backoff
                const nextRetry = new Date(Date.now() + backoffSec * 1000).toISOString();

                await supabase.from('processing_queue').update({
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: nextRetry,
                    error_message: `جاري معالجة الملف على سيرفرات Gemini... (محاولة ${pollCount + 1})`,
                    payload: {
                        ...payload,
                        poll_count: pollCount + 1
                    }
                }).eq('id', jobId);

                return new Response(JSON.stringify({ status: 'polling', poll_count: pollCount + 1 }), { headers: corsHeaders });
            }

            // ╔══════════════════════════════════════════════════════════╗
            // ║   STAGE 3: TRANSCRIBE — File is ACTIVE, extract text    ║
            // ╚══════════════════════════════════════════════════════════╝
            if (stage === 'transcribe') {
                const fileUri = payload.gemini_file_uri;
                if (!fileUri) throw new Error('Missing gemini_file_uri in payload for transcribe stage');

                console.log(`[audio-worker] Starting Gemini transcription with file URI: ${fileUri}`);
                await updateProgress('نجح الرفع. جاري الاستماع للمقطع وتفريغ النصوص (Gemini 1.5 Pro)... هذه العملية قد تستغرق بضع دقائق.');

                const fullTranscript = await transcribeWithGemini(fileUri, geminiKey);
                console.log(`[audio-worker] Gemini Pro transcription successful. Length: ${fullTranscript.length}`);

                if (!fullTranscript || fullTranscript.length < 5) {
                    console.warn(`[audio-worker] Transcription returned unusually short text.`);
                }

                await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                return new Response(JSON.stringify({ status: 'completed', transcript_length: fullTranscript.length }), { headers: corsHeaders });
            }

            throw new Error(`Unknown audio-worker stage: ${stage}`);
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
                    const { data: currentJob } = await supabase.from('processing_queue')
                        .select('attempt_count').eq('id', jobId).single();
                    const attempts = (currentJob?.attempt_count || 0);
                    if (attempts >= 5) {
                        await supabase.from('processing_queue').update({
                            status: 'failed',
                            error_message: error.message || 'Unknown Audio Worker Error (max retries exceeded)',
                            locked_by: null,
                            locked_at: null
                        }).eq('id', jobId);
                    } else {
                        // Allow retry — reset to pending so orchestrator can re-dispatch
                        await supabase.from('processing_queue').update({
                            status: 'pending',
                            error_message: `Retry ${attempts}/5: ${error.message || 'Unknown Audio Worker Error'}`,
                            locked_by: null,
                            locked_at: null
                        }).eq('id', jobId);
                    }
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});

// ─── Shared: Save transcript and mark job completed ───
async function saveTranscriptAndComplete(
    supabase: any,
    lessonId: string,
    jobId: string,
    transcript: string,
    payload: any,
    updateProgress: (msg: string) => Promise<void>
) {
    await updateProgress('اكتمل التفريغ! جاري حفظ النصوص المفرغة...');

    const storagePath = `audio_transcripts/${lessonId}/raw_transcript.txt`;
    await supabase.storage.from('audio_transcripts').upload(storagePath, transcript, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

    console.log(`[audio-worker] Successfully transcribed and saved audio for lesson ${lessonId}.`);

    await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

    // Trigger segmentation
    await supabase.from('processing_queue').upsert({
        lesson_id: lessonId,
        job_type: 'segment_lesson',
        payload: { ...payload, stage: undefined, gemini_file_uri: undefined, gemini_file_name: undefined, poll_count: undefined },
        status: 'pending',
        dedupe_key: `lesson:${lessonId}:segment_lesson`
    }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
}
