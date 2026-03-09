import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_MODEL = 'gemini-2.5-flash'; // Updated from deprecated gemini-2.0-flash

// ─── Fix MIME type: Supabase Storage returns video/mp4 for WhatsApp audio ───
// Gemini REJECTS video/mp4 for audio content (400 INVALID_ARGUMENT).
// Must convert to audio/mp4 or audio/mpeg.
function fixAudioMimeType(mime: string): string {
    if (mime === 'video/mp4' || mime === 'video/mpeg') return 'audio/mp4';
    if (mime === 'video/webm') return 'audio/webm';
    if (mime === 'video/ogg') return 'audio/ogg';
    if (!mime || mime === 'application/octet-stream') return 'audio/mp4';
    return mime;
}

// ─── Hallucination Detection ───
// Detects when Gemini/Whisper outputs repetitive garbage instead of real transcription
function isHallucinated(text: string): { hallucinated: boolean; reason: string } {
    if (!text || text.length < 50) return { hallucinated: false, reason: '' };

    const words = text.split(/\s+/);
    if (words.length < 20) return { hallucinated: false, reason: '' };

    // Check 3-word phrase repetitions
    const phrases: Record<string, number> = {};
    for (let i = 0; i < words.length - 2; i++) {
        const phrase = words.slice(i, i + 3).join(' ');
        phrases[phrase] = (phrases[phrase] || 0) + 1;
    }
    const maxRepeat = Math.max(...Object.values(phrases), 0);
    const topPhrase = Object.entries(phrases).sort((a, b) => b[1] - a[1])[0];

    if (maxRepeat > 5) {
        // Count how many words are part of repeated phrases
        let repeatedWords = 0;
        for (const [phrase, count] of Object.entries(phrases)) {
            if (count > 5) repeatedWords += count * 3;
        }
        const repeatRatio = repeatedWords / words.length;

        if (repeatRatio > 0.4 || maxRepeat > 20) {
            return {
                hallucinated: true,
                reason: `Phrase "${topPhrase?.[0]?.substring(0, 30)}" repeated ${maxRepeat}x (${(repeatRatio * 100).toFixed(0)}% repetitive)`
            };
        }
    }

    // Check unique word ratio — hallucinated text has very few unique words
    const uniqueWords = new Set(words);
    const uniqueRatio = uniqueWords.size / words.length;
    if (words.length > 100 && uniqueRatio < 0.05) {
        return { hallucinated: true, reason: `Only ${uniqueWords.size} unique words in ${words.length} total (${(uniqueRatio * 100).toFixed(1)}% unique)` };
    }

    return { hallucinated: false, reason: '' };
}

// ─── Inline Base64 Transcription (NO File API — single call!) ───
// Works for files ≤ 20MB. Downloads audio → base64 → sends directly to Gemini.
async function transcribeInline(audioUrl: string, rawMimeType: string, apiKey: string): Promise<string> {
    const mimeType = fixAudioMimeType(rawMimeType);
    console.log(`[audio-worker] Inline: MIME fixed from '${rawMimeType}' to '${mimeType}'`);
    console.log(`[audio-worker] Downloading audio for inline transcription...`);
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error(`Failed to download audio: HTTP ${audioRes.status}`);

    // Read as ArrayBuffer and convert to base64 using Deno
    const arrayBuffer = await audioRes.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    // Deno base64 encode
    let base64Audio: string;
    // @ts-ignore — Deno has btoa but for binary we need a different approach
    const CHUNK = 32768;
    let binaryString = '';
    for (let i = 0; i < uint8.length; i += CHUNK) {
        const slice = uint8.subarray(i, Math.min(i + CHUNK, uint8.length));
        binaryString += String.fromCharCode(...slice);
    }
    base64Audio = btoa(binaryString);

    const sizeMB = (uint8.length / 1024 / 1024).toFixed(2);
    console.log(`[audio-worker] Audio downloaded: ${sizeMB}MB. Base64 ready. Sending to Gemini ${GEMINI_MODEL}...`);

    const prompt = "Transcribe this Arabic audio recording word-by-word into Arabic text. Output ONLY the spoken Arabic words, nothing else. Do not add timestamps. Do not translate. Write the complete transcription in Arabic.";

    const apiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType, data: base64Audio } }
                    ]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 8192,
                }
            })
        }
    );

    if (!apiRes.ok) {
        const errText = await apiRes.text();
        throw new Error(`Gemini inline transcription failed (${apiRes.status}): ${errText.substring(0, 300)}`);
    }

    const data = await apiRes.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
}

// ─── File API: Upload audio stream to Gemini ───
// Only used for files > 20MB that can't be sent inline
async function uploadStreamToGemini(audioUrl: string, apiKey: string): Promise<{ fileUri: string; fileName: string }> {
    const headRes = await fetch(audioUrl, { method: 'HEAD' });
    const contentLength = headRes.headers.get('content-length');
    const rawMime = headRes.headers.get('content-type') || 'audio/mp3';
    const mimeType = fixAudioMimeType(rawMime);
    console.log(`[audio-worker] File API upload: MIME fixed from '${rawMime}' to '${mimeType}'`);

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
    const fileName = fileInfo.file?.name;
    if (!fileUri || !fileName) throw new Error('No file URI/name returned from Gemini');

    return { fileUri, fileName };
}

// ─── File API: Check if Gemini file is ready ───
async function checkGeminiFileStatus(fileName: string, apiKey: string): Promise<'ACTIVE' | 'PROCESSING' | 'FAILED'> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
    if (!res.ok) {
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

// ─── File API: Transcribe using file URI ───
async function transcribeWithFileUri(fileUri: string, apiKey: string, rawMimeType: string): Promise<string> {
    const mimeType = fixAudioMimeType(rawMimeType);
    const prompt = "Transcribe this Arabic audio recording word-by-word into Arabic text. Output ONLY the spoken Arabic words, nothing else. Do not add timestamps. Do not translate. Write the complete transcription in Arabic.";

    const apiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { fileData: { fileUri, mimeType } }
                    ]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 8192,
                }
            })
        }
    );

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

        console.log(`[audio-worker] ▶ EXECUTING ${job_type} | stage: ${stage} | lesson: ${lesson_id} | attempt: ${job.attempt_count || 0} | audioPath: ${audioPath}`);

        const updateProgress = async (msg: string) => {
            console.log(`[audio-worker-progress] ${msg}`);
            await supabase.from('processing_queue').update({ error_message: msg }).eq('id', jobId);
        };

        if (job_type === 'transcribe_audio') {
            if (!audioPath) throw new Error('Missing audio_url to process');

            // ╔══════════════════════════════════════════════════════════════╗
            // ║   STAGE 1: UPLOAD — Try Whisper first, then Gemini inline   ║
            // ╚══════════════════════════════════════════════════════════════╝
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
                const rawMimeType = headRes.headers.get('content-type') || 'audio/mp4';
                const mimeType = fixAudioMimeType(rawMimeType);
                console.log(`[audio-worker] Audio file: ${fileSizeMB.toFixed(2)} MB, raw type: ${rawMimeType}, fixed: ${mimeType}`);

                let fullTranscript = '';
                let whisperDone = false;

                // ── PRIORITY 1: Whisper for files ≤25MB (Whisper's official limit) ──
                // Raised from 15MB because Gemini File API is unreliable (500 errors).
                // Whisper works great up to 25MB even for Arabic audio.
                if (openaiKey && fileSizeMB <= 25) {
                    try {
                        console.log(`[audio-worker] Using Whisper (${fileSizeMB.toFixed(1)}MB)...`);
                        await updateProgress('جاري تفريغ الصوت بدقة عالية (OpenAI Whisper)...');

                        const audioRes = await fetch(audioUrl);
                        let audioBlob: Blob | null = await audioRes.blob();

                        // Use correct extension based on mime type
                        const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : 'mp3';
                        const formData = new FormData();
                        formData.append('file', audioBlob, `audio.${ext}`);
                        formData.append('model', 'whisper-1');
                        formData.append('response_format', 'text');
                        formData.append('language', 'ar');
                        formData.append('prompt', 'محاضرة جامعية باللغة العربية الفصحى');

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
                    console.log(`[audio-worker] Audio too large for Whisper (${fileSizeMB.toFixed(1)}MB > 25MB). Skipping to Gemini.`);
                }

                // Quality check: detect Whisper hallucination
                if (whisperDone && fullTranscript) {
                    const expectedMinChars = fileSizeMB * 200;
                    if (fullTranscript.length < expectedMinChars) {
                        console.warn(`[audio-worker] Whisper output too short: ${fullTranscript.length} chars for ${fileSizeMB.toFixed(1)}MB (expected ≥${expectedMinChars}). Falling back to Gemini.`);
                        whisperDone = false;
                        fullTranscript = '';
                    }
                }

                if (whisperDone && fullTranscript) {
                    const hallCheck = isHallucinated(fullTranscript);
                    if (hallCheck.hallucinated) {
                        console.warn(`[audio-worker] Whisper hallucination: ${hallCheck.reason}. Falling back to Gemini.`);
                        whisperDone = false;
                        fullTranscript = '';
                    }
                }

                // If Whisper passed quality checks → clean and save
                if (whisperDone && fullTranscript) {
                    fullTranscript = cleanTranscriptRepetitions(fullTranscript);
                    console.log(`[audio-worker] Whisper quality OK. Cleaned length: ${fullTranscript.length}`);
                    await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                    return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
                }

                // ── PRIORITY 2: Gemini INLINE transcription (≤20MB) ──
                // This bypasses the Gemini File API entirely — no upload/poll/timeout!
                if (geminiKey && fileSizeMB <= 20) {
                    console.log(`[audio-worker] Using Gemini INLINE transcription (${fileSizeMB.toFixed(1)}MB, type: ${mimeType})...`);
                    await updateProgress('جاري تفريغ الصوت مباشرة عبر Gemini (وضع مباشر)...');

                    try {
                        fullTranscript = await transcribeInline(audioUrl, mimeType, geminiKey);
                        fullTranscript = cleanTranscriptRepetitions(fullTranscript);
                        console.log(`[audio-worker] Gemini inline transcription successful. Cleaned length: ${fullTranscript.length}`);

                        const hallCheck = isHallucinated(fullTranscript);
                        if (hallCheck.hallucinated) {
                            console.warn(`[audio-worker] Gemini inline hallucination: ${hallCheck.reason}. Falling back to File API.`);
                        } else if (fullTranscript && fullTranscript.length >= 5) {
                            await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                            return new Response(JSON.stringify({ status: 'completed', transcript_length: fullTranscript.length }), { headers: corsHeaders });
                        } else {
                            console.warn(`[audio-worker] Gemini inline returned empty/too-short text. Falling back to File API.`);
                        }
                    } catch (e: any) {
                        console.warn(`[audio-worker] Gemini inline failed: ${e.message}. Falling back to File API.`);
                    }
                }

                // ── PRIORITY 3: Gemini File API (for files > 20MB or if inline failed) ──
                if (!geminiKey) throw new Error('Missing GEMINI_API_KEY for audio transcription');

                console.log(`[audio-worker] Falling back to Gemini File API (streaming upload for ${fileSizeMB.toFixed(2)}MB)...`);
                await updateProgress('جاري رفع المقطع إلى Gemini File API للملفات الكبيرة...');

                const { fileUri, fileName } = await uploadStreamToGemini(audioUrl, geminiKey);
                console.log(`[audio-worker] Upload OK. URI: ${fileUri}, Name: ${fileName}. Transitioning to polling.`);

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
                        gemini_mime_type: mimeType,
                        poll_count: 0,
                        file_size_mb: fileSizeMB,
                    }
                }).eq('id', jobId);

                return new Response(JSON.stringify({ status: 'staged', next_stage: 'polling_gemini' }), { headers: corsHeaders });
            }

            // ╔══════════════════════════════════════════════════════╗
            // ║   STAGE 2: POLLING — Wait for Gemini File API      ║
            // ╚══════════════════════════════════════════════════════╝
            if (stage === 'polling_gemini') {
                const fileName = payload.gemini_file_name;
                const fileUri = payload.gemini_file_uri;
                const pollCount = payload.poll_count || 0;
                const mimeType = payload.gemini_mime_type || 'audio/mp4';

                if (!fileName || !fileUri) throw new Error('Missing gemini_file_name/uri in payload for polling stage');

                await updateProgress('جاري استخراج النصوص من الريكورد (Gemini File API)...');

                console.log(`[audio-worker] Polling Gemini file status: ${fileName} (poll #${pollCount})`);
                const fileStatus = await checkGeminiFileStatus(fileName, geminiKey);

                if (fileStatus === 'ACTIVE') {
                    console.log(`[audio-worker] File ${fileName} is ACTIVE. Transitioning to transcribe.`);

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
                if (pollCount >= 20) {
                    // 20 polls × ~15-20s = ~5-7 minutes max wait
                    throw new Error(`Gemini file processing timeout after ${pollCount} polls (~${Math.round(pollCount * 15 / 60)} min).`);
                }

                console.log(`[audio-worker] Gemini still processing ${fileName}... re-queuing (poll #${pollCount}).`);
                const backoffSec = Math.min(10 + pollCount * 2, 30);
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

            // ╔══════════════════════════════════════════════════════════════════╗
            // ║   STAGE 3: TRANSCRIBE — Chunked for long lectures (up to 2hr)  ║
            // ╚══════════════════════════════════════════════════════════════════╝
            if (stage === 'transcribe') {
                const fileUri = payload.gemini_file_uri;
                const mimeType = payload.gemini_mime_type || 'audio/mp4';
                const fileSizeMB = payload.file_size_mb || 20;
                if (!fileUri) throw new Error('Missing gemini_file_uri in payload for transcribe stage');

                // Estimate duration: ~1MB ≈ 1 min for compressed audio
                const estimatedMinutes = Math.max(1, Math.round(fileSizeMB));
                const CHUNK_MINUTES = 15;
                const currentChunk = payload.current_chunk || 0;
                const totalChunks = Math.ceil(estimatedMinutes / CHUNK_MINUTES);
                const transcriptParts: string[] = payload.transcript_parts || [];

                console.log(`[audio-worker] Transcribe: ~${estimatedMinutes}min audio | chunk ${currentChunk + 1}/${totalChunks} | ${transcriptParts.length} parts saved`);

                // ── Short audio (≤10 min): single call ──
                if (estimatedMinutes <= 10) {
                    console.log(`[audio-worker] Short audio (${estimatedMinutes}min). Single transcription call.`);
                    await updateProgress('جاري تفريغ المحاضرة بالكامل...');

                    let fullTranscript = await transcribeWithFileUri(fileUri, geminiKey, mimeType);
                    fullTranscript = cleanTranscriptRepetitions(fullTranscript);
                    console.log(`[audio-worker] Transcription done. Length: ${fullTranscript.length} chars`);

                    const hallCheck = isHallucinated(fullTranscript);
                    if (hallCheck.hallucinated) {
                        console.warn(`[audio-worker] Gemini single-call hallucination: ${hallCheck.reason}. Saving partial.`);
                    }

                    await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                    return new Response(JSON.stringify({ status: 'completed', transcript_length: fullTranscript.length }), { headers: corsHeaders });
                }

                // ── Longer audio (>10 min): chunked transcription ──
                if (currentChunk >= totalChunks) {
                    // All chunks done — combine and save
                    const fullTranscript = cleanTranscriptRepetitions(transcriptParts.join('\n\n'));
                    console.log(`[audio-worker] All ${totalChunks} chunks done. Total: ${fullTranscript.length} chars`);
                    await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                    return new Response(JSON.stringify({ status: 'completed', transcript_length: fullTranscript.length }), { headers: corsHeaders });
                }

                // Transcribe current chunk
                const startMin = currentChunk * CHUNK_MINUTES;
                const endMin = Math.min((currentChunk + 1) * CHUNK_MINUTES, estimatedMinutes);
                await updateProgress(`جاري تفريغ الجزء ${currentChunk + 1} من ${totalChunks} (الدقيقة ${startMin}-${endMin})...`);

                const chunkPrompt = totalChunks === 1
                    ? "Transcribe this Arabic audio recording word-by-word into Arabic text. Output ONLY the spoken Arabic words, nothing else. Do not add timestamps. Do not translate. Write the complete transcription in Arabic. Make sure you transcribe the ENTIRE recording from beginning to end."
                    : `Transcribe ONLY the part of this Arabic audio recording from minute ${startMin} to minute ${endMin}. Output ONLY the spoken Arabic words for this time segment. Do not add timestamps. Do not translate. Do not include content outside this time range. Write the transcription in Arabic.`;

                console.log(`[audio-worker] Transcribing chunk ${currentChunk + 1}/${totalChunks}: minutes ${startMin}-${endMin}`);
                const chunkMimeType = fixAudioMimeType(mimeType);

                const apiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{
                                role: 'user',
                                parts: [
                                    { text: chunkPrompt },
                                    { fileData: { fileUri, mimeType: chunkMimeType } }
                                ]
                            }],
                            generationConfig: { temperature: 0, maxOutputTokens: 8192 }
                        })
                    }
                );

                if (!apiRes.ok) {
                    const errText = await apiRes.text();
                    throw new Error(`Gemini chunk ${currentChunk + 1} failed: ${errText.substring(0, 200)}`);
                }

                const data = await apiRes.json();
                const chunkText = (data.candidates?.[0]?.content?.parts || [])
                    .filter((p: any) => p.text).map((p: any) => p.text).join('').trim();

                console.log(`[audio-worker] Chunk ${currentChunk + 1} done: ${chunkText.length} chars`);
                transcriptParts.push(chunkText);

                const nextChunk = currentChunk + 1;
                if (nextChunk >= totalChunks) {
                    // Last chunk done — combine and save
                    const fullTranscript = cleanTranscriptRepetitions(transcriptParts.join('\n\n'));
                    console.log(`[audio-worker] All chunks complete! Total: ${fullTranscript.length} chars`);

                    const hallCheck = isHallucinated(fullTranscript);
                    if (hallCheck.hallucinated) {
                        console.warn(`[audio-worker] Combined transcript hallucination detected: ${hallCheck.reason}. Saving cleaned version.`);
                    }

                    await saveTranscriptAndComplete(supabase, lesson_id, jobId!, fullTranscript, payload, updateProgress);
                    return new Response(JSON.stringify({ status: 'completed', transcript_length: fullTranscript.length, chunks: totalChunks }), { headers: corsHeaders });
                }

                // More chunks to go — save progress and re-queue
                console.log(`[audio-worker] Chunk ${currentChunk + 1}/${totalChunks} done. Re-queuing for next chunk.`);
                const nextRetry = new Date(Date.now() + 2000).toISOString();
                await supabase.from('processing_queue').update({
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: nextRetry,
                    attempt_count: 0,
                    error_message: `تم تفريغ ${nextChunk}/${totalChunks} أجزاء...`,
                    payload: {
                        ...payload,
                        current_chunk: nextChunk,
                        transcript_parts: transcriptParts,
                    }
                }).eq('id', jobId);

                return new Response(JSON.stringify({ status: 'chunking', chunk: nextChunk, total: totalChunks }), { headers: corsHeaders });
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
                    const attempts = (currentJob?.attempt_count || 0) + 1;
                    console.error(`[audio-worker] ❌ Attempt ${attempts}/5 failed: ${error.message}`);
                    if (attempts >= 5) {
                        await supabase.from('processing_queue').update({
                            status: 'failed',
                            attempt_count: attempts,
                            error_message: `فشل نهائي (${attempts} محاولات): ${error.message || 'Unknown Audio Worker Error'}`,
                            locked_by: null,
                            locked_at: null
                        }).eq('id', jobId);
                    } else {
                        const backoffMs = Math.min(Math.pow(2, attempts) * 3000, 60000);
                        const nextRetry = new Date(Date.now() + backoffMs).toISOString();
                        await supabase.from('processing_queue').update({
                            status: 'pending',
                            attempt_count: attempts,
                            error_message: `محاولة ${attempts}/5: ${error.message || 'Unknown Audio Worker Error'}`,
                            locked_by: null,
                            locked_at: null,
                            next_retry_at: nextRetry
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

    // Fallback: try saving to 'ocr' bucket
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

    // Safety net: ALWAYS save transcript to lessons table
    try {
        await supabase.from('lessons').update({
            audio_transcript: transcript.substring(0, 100000)
        }).eq('id', lessonId);
        console.log(`[audio-worker] ✅ Transcript also saved to lessons.audio_transcript column`);
    } catch (e: any) {
        console.warn(`[audio-worker] Could not save to lessons table:`, e.message);
    }

    console.log(`[audio-worker] Successfully transcribed audio for lesson ${lessonId}. Saved: ${saved}`);

    await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

    // Trigger segmentation
    await supabase.from('processing_queue').upsert({
        lesson_id: lessonId,
        job_type: 'segment_lesson',
        payload: { ...payload, stage: undefined, gemini_file_uri: undefined, gemini_file_name: undefined, poll_count: undefined, gemini_mime_type: undefined },
        status: 'pending',
        dedupe_key: `lesson:${lessonId}:segment_lesson`
    }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
}

// ─── Helper: Remove repetitions from transcripts ───
function cleanTranscriptRepetitions(text: string): string {
    // Step 1: Remove word-level repetitions (3+ consecutive same words)
    let result = text.replace(/(\b[\u0600-\u06FF]+\b)(\s+\1){2,}/g, '$1');

    // Step 2: Remove repeated phrases (3-word sequences appearing >5 times)
    const words = result.split(/\s+/);
    const phraseCounts: Record<string, number> = {};
    for (let i = 0; i < words.length - 2; i++) {
        const phrase = words.slice(i, i + 3).join(' ');
        phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
    }

    // Mark phrases that appear too many times
    const badPhrases = new Set(
        Object.entries(phraseCounts)
            .filter(([_, count]) => count > 5)
            .map(([phrase]) => phrase)
    );

    if (badPhrases.size > 0) {
        const cleanedWords: string[] = [];
        const seenBadPhrases: Record<string, number> = {};

        for (let i = 0; i < words.length; i++) {
            if (i < words.length - 2) {
                const phrase = words.slice(i, i + 3).join(' ');
                if (badPhrases.has(phrase)) {
                    seenBadPhrases[phrase] = (seenBadPhrases[phrase] || 0) + 1;
                    if (seenBadPhrases[phrase] > 3) {
                        i += 2; // Skip the repeated phrase
                        continue;
                    }
                }
            }
            cleanedWords.push(words[i]);
        }
        result = cleanedWords.join(' ');
    }

    // Step 3: Remove sentence-level exact repeats
    const sentences = result.split(/[.،!؟\n]+/).map(s => s.trim()).filter(s => s.length > 5);
    const cleanedSentences: string[] = [];
    let lastSentence = '';
    let repeatCount = 0;

    for (const sentence of sentences) {
        if (sentence === lastSentence || (lastSentence.length > 10 && sentence.includes(lastSentence.substring(0, Math.min(lastSentence.length, 30))))) {
            repeatCount++;
            if (repeatCount <= 1) cleanedSentences.push(sentence);
        } else {
            cleanedSentences.push(sentence);
            repeatCount = 0;
        }
        lastSentence = sentence;
    }

    return cleanedSentences.join('. ');
}
