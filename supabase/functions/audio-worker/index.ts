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

// ─── Stage 3 Helper: Transcribe with Gemini using file URI (parallel chunks) ───
async function transcribeWithGemini(fileUri: string, apiKey: string, fileSizeMB?: number): Promise<string> {
    // Estimate audio duration: ~1MB ≈ 1 minute for compressed audio
    const estimatedMinutes = Math.max(1, Math.round(fileSizeMB || 10));
    const CHUNK_SIZE_MINUTES = 10;

    // If short audio (<= 12 min), do single transcription
    if (estimatedMinutes <= 12) {
        return await geminiTranscribeChunk(fileUri, apiKey, null);
    }

    // Split into chunks and transcribe in parallel
    const numChunks = Math.ceil(estimatedMinutes / CHUNK_SIZE_MINUTES);
    console.log(`[audio-worker] Splitting ${estimatedMinutes}min audio into ${numChunks} chunks for parallel transcription`);

    const chunkPromises = [];
    for (let i = 0; i < numChunks; i++) {
        const startMin = i * CHUNK_SIZE_MINUTES;
        const endMin = Math.min((i + 1) * CHUNK_SIZE_MINUTES, estimatedMinutes);
        chunkPromises.push(
            geminiTranscribeChunk(fileUri, apiKey, { start: startMin, end: endMin, part: i + 1, total: numChunks })
        );
    }

    const results = await Promise.allSettled(chunkPromises);
    const transcripts: string[] = [];
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
            transcripts.push(r.value);
        } else if (r.status === 'rejected') {
            console.warn(`[audio-worker] Chunk transcription failed:`, r.reason?.message);
        }
    }

    console.log(`[audio-worker] Parallel transcription done: ${transcripts.length}/${numChunks} chunks succeeded`);
    return transcripts.join('\n\n');
}

// ─── Single chunk transcription call ───
async function geminiTranscribeChunk(
    fileUri: string, apiKey: string,
    timeRange: { start: number; end: number; part: number; total: number } | null
): Promise<string> {
    let prompt: string;
    if (timeRange) {
        prompt = `أنت خبير في التفريغ الصوتي. هذا الملف الصوتي مقسم إلى ${timeRange.total} أجزاء.
قم بتفريغ الجزء ${timeRange.part} فقط: من الدقيقة ${timeRange.start} إلى الدقيقة ${timeRange.end}.
اكتب النص بالكامل كما قيل بدون تلخيص أو حذف. تأكد من صحة الإملاء والعبارات.
لا تكتب أي شيء خارج هذا النطاق الزمني. ابدأ التفريغ مباشرة بدون مقدمة.`;
    } else {
        prompt = "أنت خبير في التفريغ الصوتي (Transcription). قم بتفريغ هذا المقطع الصوتي بكل دقة إلى نص عربي واضح ومترابط. اكتب النص بالكامل كما قيل بدون تلخيص، وتأكد من صحة الإملاء والوقفات.";
    }

    const apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
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
                maxOutputTokens: 65536,
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

                // Whisper for files ≤25MB (OpenAI's actual limit) — more accurate for Arabic
                if (openaiKey && fileSizeMB <= 25) {
                    try {
                        console.log(`[audio-worker] Short audio (${fileSizeMB.toFixed(1)}MB). Using Whisper...`);
                        await updateProgress('جاري تفريغ الصوت بدقة عالية (OpenAI Whisper)...');

                        const audioRes = await fetch(audioUrl);
                        let audioBlob: Blob | null = await audioRes.blob();

                        const formData = new FormData();
                        formData.append('file', audioBlob, 'audio.mp3');
                        formData.append('model', 'whisper-1');
                        formData.append('response_format', 'text');
                        formData.append('language', 'ar'); // Arabic hint for better accuracy
                        formData.append('prompt', 'محاضرة جامعية باللغة العربية الفصحى'); // Context hint

                        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${openaiKey}` },
                            body: formData
                        });

                        if (whisperRes.ok) {
                            fullTranscript = await whisperRes.text();
                            whisperDone = true;
                            console.log(`[audio-worker] Whisper OK. Length: ${fullTranscript.length}`);
                        } else {
                            const errText = await whisperRes.text();
                            console.warn(`[audio-worker] Whisper Failed (${whisperRes.status}): ${errText}`);
                        }
                        audioBlob = null;
                    } catch (e: any) {
                        console.warn(`[audio-worker] Whisper exception: ${e.message}`);
                    }
                } else if (openaiKey && fileSizeMB > 25) {
                    console.log(`[audio-worker] Audio too large for Whisper (${fileSizeMB.toFixed(1)}MB > 25MB). Skipping to Gemini chunked transcription.`);
                }

                // Quality check: detect Whisper hallucination
                if (whisperDone && fullTranscript) {
                    // Check 1: Suspiciously short for file size
                    const expectedMinChars = fileSizeMB * 300; // ~300 chars per MB minimum (Arabic with pauses)
                    if (fullTranscript.length < expectedMinChars) {
                        console.warn(`[audio-worker] Whisper output too short: ${fullTranscript.length} chars for ${fileSizeMB.toFixed(1)}MB (expected >=${expectedMinChars.toFixed(0)}). Falling back to Gemini.`);
                        whisperDone = false;
                        fullTranscript = '';
                    }
                }

                if (whisperDone && fullTranscript) {
                    // Check 2: Detect repeated phrases (hallucination)
                    const words = fullTranscript.split(/\s+/);
                    const phrases: Record<string, number> = {};
                    for (let i = 0; i < words.length - 4; i++) {
                        const phrase = words.slice(i, i + 4).join(' ');
                        phrases[phrase] = (phrases[phrase] || 0) + 1;
                    }
                    const maxRepeat = Math.max(...Object.values(phrases), 0);
                    if (maxRepeat > 10) {
                        console.warn(`[audio-worker] Whisper hallucination detected: phrase repeated ${maxRepeat} times. Falling back to Gemini.`);
                        whisperDone = false;
                        fullTranscript = '';
                    }
                }

                // If Whisper passed quality checks → clean and save
                if (whisperDone && fullTranscript) {
                    // Clean transcript: remove consecutive duplicate sentences
                    fullTranscript = cleanTranscriptRepetitions(fullTranscript);
                    console.log(`[audio-worker] Whisper quality OK. Cleaned length: ${fullTranscript.length}`);
                    await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                    return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
                }

                // Whisper not used or failed → Upload to Gemini
                if (!geminiKey) throw new Error('Missing GEMINI_API_KEY for fallback audio transcription');

                console.log(`[audio-worker] Whisper not available or failed quality check. Falling back to Gemini Stream (${fileSizeMB.toFixed(2)}MB).`);
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
                        poll_count: 0,
                        file_size_mb: fileSizeMB,
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
                if (pollCount >= 30) {
                    // 30 polls × ~15s = ~7.5 minutes max wait
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

                let fullTranscript = await transcribeWithGemini(fileUri, geminiKey, payload.file_size_mb);
                fullTranscript = cleanTranscriptRepetitions(fullTranscript);
                console.log(`[audio-worker] Gemini Pro transcription successful. Cleaned length: ${fullTranscript.length}`);

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

    let saved = false;

    // Try primary path: audio_transcripts bucket
    try {
        const storagePath = `${lessonId}/raw_transcript.txt`;
        const { error: uploadErr } = await supabase.storage
            .from('audio_transcripts')
            .upload(storagePath, transcript, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

        if (uploadErr) {
            console.error(`[audio-worker] Upload to audio_transcripts/${storagePath} FAILED:`, uploadErr.message);
        } else {
            console.log(`[audio-worker] ✅ Transcript saved to audio_transcripts/${storagePath} (${transcript.length} chars)`);
            saved = true;
        }
    } catch (e: any) {
        console.error(`[audio-worker] Storage upload exception:`, e.message);
    }

    // Fallback: try saving to 'ocr' bucket (which definitely exists)
    if (!saved) {
        try {
            const fallbackPath = `${lessonId}/audio_transcript.txt`;
            const { error: fallbackErr } = await supabase.storage
                .from('ocr')
                .upload(fallbackPath, transcript, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

            if (fallbackErr) {
                console.error(`[audio-worker] Fallback upload to ocr/${fallbackPath} FAILED:`, fallbackErr.message);
            } else {
                console.log(`[audio-worker] ✅ Transcript saved to ocr/${fallbackPath} (fallback)`);
                saved = true;
            }
        } catch (e: any) {
            console.error(`[audio-worker] Fallback storage exception:`, e.message);
        }
    }

    // Safety net: ALWAYS save transcript to lessons table (never lost)
    try {
        await supabase.from('lessons').update({
            audio_transcript: transcript.substring(0, 100000) // Limit to 100K chars for DB
        }).eq('id', lessonId);
        console.log(`[audio-worker] ✅ Transcript also saved to lessons.audio_transcript column`);
    } catch (e: any) {
        console.warn(`[audio-worker] Could not save to lessons table (column may not exist):`, e.message);
    }

    console.log(`[audio-worker] Successfully transcribed audio for lesson ${lessonId}. Saved: ${saved}`);

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

// ─── Helper: Remove repetitions from transcripts ───
function cleanTranscriptRepetitions(text: string): string {
    // Split into sentences
    const sentences = text.split(/[.،!؟\n]+/).map(s => s.trim()).filter(s => s.length > 5);
    const cleaned: string[] = [];
    let lastSentence = '';
    let repeatCount = 0;

    for (const sentence of sentences) {
        // Check if this sentence is very similar to the last one
        if (sentence === lastSentence || (lastSentence.length > 10 && sentence.includes(lastSentence.substring(0, Math.min(lastSentence.length, 30))))) {
            repeatCount++;
            if (repeatCount <= 1) cleaned.push(sentence); // Allow 1 repeat max
        } else {
            cleaned.push(sentence);
            repeatCount = 0;
        }
        lastSentence = sentence;
    }

    // Also remove word-level repetitions (e.g. "استدعى استدعى استدعى" → "استدعى")
    let result = cleaned.join('. ');
    result = result.replace(/(\b[\u0600-\u06FF]+\b)(\s+\1){2,}/g, '$1');

    return result;
}
