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
    if (!audioStreamRes.ok) throw new Error('Failed to fetch audio from Storage');

    // NATIVE DENO FIX: Deno fetch streaming into another fetch body often corrupts the Google Resumable Upload.
    // Instead of streaming `audioStreamRes.body`, we load it into an ArrayBuffer and upload fully.
    const fileBuffer = await audioStreamRes.arrayBuffer();

    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': contentLength,
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: fileBuffer
    });

    if (!uploadRes.ok) throw new Error(`Gemini File API upload failed: ${uploadRes.status} ${await uploadRes.text()}`);

    const fileInfo = await uploadRes.json();
    const fileUri = fileInfo.file?.uri;
    const fileName = fileInfo.file?.name; // e.g. "files/abc123"
    if (!fileUri || !fileName) throw new Error('No file URI/name returned from Gemini');

    return { fileUri, fileName };
}

// ─── Stage 2 Helper: Check if Gemini file is ready (single check, no loop!) ───
async function checkGeminiFileStatus(fileName: string, apiKey: string): Promise<'ACTIVE' | 'PROCESSING' | 'FAILED' | 'ERROR'> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
    if (!res.ok) {
        console.warn(`[audio-worker] Gemini file status check failed (${res.status}): ${await res.text().catch(() => '')}`);
        return 'ERROR';
    }
    const status = await res.json();
    if (status.state === 'ACTIVE') return 'ACTIVE';
    if (status.state === 'FAILED') return 'FAILED';
    return 'PROCESSING';
}

// ─── Stage 3 Helper: Transcribe with Gemini using file URI ───
// Uses gemini-2.5-flash with maxOutputTokens: 65536 + finishReason continuation
// Future: migrate to Whisper/Speech-to-Text for transcription, Gemini for analysis only
async function transcribeWithGemini(fileUri: string, apiKey: string): Promise<string> {
    const TRANSCRIPTION_PROMPT = `أنت مفرّغ صوتي محترف ودقيق جداً متخصص في المحتوى الأكاديمي العربي.
حوّل كل الكلام في هذا التسجيل الصوتي إلى نص عربي مكتوب بأعلى دقة ممكنة.

⚠️ قواعد صارمة:
- فرّغ التسجيل كاملاً من أوله لآخره بدون توقف أو تخطي أي جزء
- اكتب كل كلمة بدون حذف أو اختصار أو تلخيص
- المصطلحات العلمية والأسماء الخاصة: اكتبها بدقة كما نُطقت
- الأرقام والتواريخ والمعادلات: اكتبها كما قالها المتحدث بالضبط
- إذا كان هناك سؤال وجواب بين المعلم والطلاب، اكتب (المعلم: ...) و(طالب: ...)
- حافظ على الترتيب الزمني للشرح
- اكتب النص المُفرَّغ فقط بدون مقدمات أو تعليقات من عندك`;

    const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const GEN_CONFIG = { temperature: 0.1, maxOutputTokens: 65536 };

    // ── Initial transcription request ──
    const apiRes = await fetch(MODEL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { text: TRANSCRIPTION_PROMPT },
                    { fileData: { fileUri: fileUri, mimeType: "audio/mp3" } }
                ]
            }],
            generationConfig: GEN_CONFIG
        })
    });

    if (!apiRes.ok) {
        throw new Error(`Gemini Transcription Failed: ${await apiRes.text()}`);
    }

    const data = await apiRes.json();
    const finishReason = data.candidates?.[0]?.finishReason;
    const resParts = data.candidates?.[0]?.content?.parts || [];
    let fullText = resParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();

    console.log(`[audio-worker] Initial transcription: ${fullText.length} chars, finishReason: ${finishReason}`);

    // ── Continuation loop: handle MAX_TOKENS truncation ──
    // For 1-2 hour recordings, 65536 tokens may not be enough in one shot
    if (finishReason === 'MAX_TOKENS' && fullText.length > 100) {
        console.log(`[audio-worker] MAX_TOKENS hit (${fullText.length} chars). Starting continuation...`);

        const MAX_CONTINUATIONS = 5;
        for (let cont = 0; cont < MAX_CONTINUATIONS; cont++) {
            const lastChunk = fullText.slice(-500);
            const continuePrompt = `أنت تكمل تفريغ تسجيل صوتي أكاديمي عربي. آخر ما تم تفريغه:
"${lastChunk}"

أكمل التفريغ من حيث توقف النص أعلاه. اكتب فقط الجزء الجديد الذي لم يُفرَّغ بعد.
لا تكرر ما تم تفريغه سابقاً. اكتب النص المُفرَّغ فقط.`;

            const contRes = await fetch(MODEL_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        role: 'user',
                        parts: [
                            { text: continuePrompt },
                            { fileData: { fileUri: fileUri, mimeType: "audio/mp3" } }
                        ]
                    }],
                    generationConfig: GEN_CONFIG
                })
            });

            if (!contRes.ok) {
                console.warn(`[audio-worker] Continuation ${cont + 1} failed: ${contRes.status}`);
                break;
            }

            const contData = await contRes.json();
            const contFinish = contData.candidates?.[0]?.finishReason;
            const contParts = contData.candidates?.[0]?.content?.parts || [];
            const contText = contParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();

            if (!contText || contText.length < 50) {
                console.log(`[audio-worker] Continuation ${cont + 1}: empty/short response. Transcription likely complete.`);
                break;
            }

            fullText += '\n' + contText;
            console.log(`[audio-worker] Continuation ${cont + 1}: +${contText.length} chars (total: ${fullText.length}), finishReason: ${contFinish}`);

            if (contFinish === 'STOP') {
                console.log(`[audio-worker] Continuation complete (STOP). Total: ${fullText.length} chars`);
                break;
            }

            if (contFinish === 'SAFETY' || contFinish === 'RECITATION') {
                console.warn(`[audio-worker] Continuation blocked: ${contFinish}. Using partial transcript.`);
                break;
            }
        }
    } else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
        console.warn(`[audio-worker] Transcription blocked by ${finishReason}. Retrying with simpler prompt...`);
        // Retry with minimal prompt
        const retryRes = await fetch(MODEL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: 'استمع للتسجيل الصوتي التالي وحوّله إلى نص عربي مكتوب. اكتب كل ما يقوله المتحدث بالضبط. اكتب النص فقط.' },
                        { fileData: { fileUri: fileUri, mimeType: "audio/mp3" } }
                    ]
                }],
                generationConfig: GEN_CONFIG
            })
        });
        if (retryRes.ok) {
            const retryData = await retryRes.json();
            const retryParts = retryData.candidates?.[0]?.content?.parts || [];
            const retryText = retryParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
            if (retryText.length > fullText.length) fullText = retryText;
        }
    }

    console.log(`[audio-worker] Final transcription: ${fullText.length} chars`);

    // CRITICAL FIX: Reject empty/very short transcripts instead of silently continuing
    if (!fullText || fullText.trim().length < 50) {
        throw new Error(`Gemini returned empty/too-short transcription (${fullText?.length || 0} chars). Audio may be silent, corrupted, or unsupported language.`);
    }

    return fullText;
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

                // Whisper PRIMARY for files ≤ 25MB (most accurate for Arabic)
                if (openaiKey && fileSizeBytes <= 25 * 1024 * 1024) {
                    try {
                        console.log(`[audio-worker] Attempting transcription with OpenAI Whisper (PRIMARY)...`);
                        await updateProgress('جاري تفريغ الصوت بدقة عالية (Whisper — الأعلى دقة للعربية)...');

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
                        audio_file_size: fileSizeBytes,
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

                if (fileStatus === 'FAILED' || fileStatus === 'ERROR') {
                    // Try to reset the upload instead of immediately failing
                    const resetCount = payload.reset_count || 0;
                    if (resetCount < 2) {
                        console.warn(`[audio-worker] Gemini file ${fileName} is FAILED/ERROR. Resetting to upload stage (reset #${resetCount + 1}).`);
                        await supabase.from('processing_queue').update({
                            status: 'pending',
                            locked_by: null,
                            locked_at: null,
                            next_retry_at: new Date().toISOString(),
                            attempt_count: 0,
                            error_message: 'واجه مزود التحليل مشكلة تقنية، جاري إعادة الرفع...',
                            payload: {
                                ...payload,
                                stage: 'upload',
                                gemini_file_uri: undefined,
                                gemini_file_name: undefined,
                                poll_count: 0,
                                reset_count: resetCount + 1
                            }
                        }).eq('id', jobId);
                        return new Response(JSON.stringify({ status: 'staged', next_stage: 'upload' }), { headers: corsHeaders });
                    } else {
                        throw new Error(`Gemini file processing FAILED on their servers repeatedly (${fileStatus}).`);
                    }
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
                    attempt_count: 0,
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
                const audioFileSize = payload.audio_file_size || 0;

                console.log(`[audio-worker] Stage 3: TRANSCRIBE — file size: ${(audioFileSize / (1024 * 1024)).toFixed(1)}MB`);

                let fullTranscript = '';
                const WHISPER_LIMIT = 25 * 1024 * 1024; // 25MB

                // ═══ STRATEGY: Whisper FIRST (most accurate for Arabic) ═══
                if (openaiKey && audioFileSize <= WHISPER_LIMIT) {
                    await updateProgress('جاري تفريغ النصوص بواسطة Whisper (الأعلى دقة للعربية)...');

                    const MAX_WHISPER_RETRIES = 5;
                    const BASE_DELAY = 2000;

                    try {
                        const { data: signedUrlData } = await supabase.storage
                            .from('homework-uploads').createSignedUrl(audioPath, 3600);

                        if (signedUrlData?.signedUrl) {
                            const audioRes = await fetch(signedUrlData.signedUrl);
                            const audioBlob = await audioRes.blob();

                            for (let attempt = 0; attempt < MAX_WHISPER_RETRIES; attempt++) {
                                try {
                                    const formData = new FormData();
                                    formData.append('file', audioBlob, 'audio.mp3');
                                    formData.append('model', 'whisper-1');
                                    formData.append('language', 'ar');
                                    formData.append('response_format', 'text');

                                    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                                        method: 'POST',
                                        headers: { 'Authorization': `Bearer ${openaiKey}` },
                                        body: formData
                                    });

                                    if (whisperRes.status === 429 || whisperRes.status >= 500) {
                                        const errText = await whisperRes.text();
                                        if (errText.includes('billing_not_active')) {
                                            console.warn('[audio-worker] Whisper billing not active. Skipping to Gemini.');
                                            break;
                                        }

                                        if (attempt < MAX_WHISPER_RETRIES - 1) {
                                            // Respect Retry-After or use exponential backoff with jitter
                                            const retryAfter = whisperRes.headers.get('Retry-After');
                                            let delayMs: number;
                                            if (retryAfter) {
                                                const secs = parseInt(retryAfter, 10);
                                                delayMs = (isNaN(secs) ? 10 : secs) * 1000;
                                            } else {
                                                delayMs = Math.min(BASE_DELAY * Math.pow(2, attempt), 64000);
                                                delayMs = delayMs * (0.75 + Math.random() * 0.5); // ±25% jitter
                                            }

                                            console.warn(`[audio-worker] ⏳ Whisper ${whisperRes.status} — retry ${attempt + 1}/${MAX_WHISPER_RETRIES} after ${(delayMs / 1000).toFixed(1)}s`);
                                            await updateProgress(`Whisper مشغول، إعادة المحاولة ${attempt + 1}/${MAX_WHISPER_RETRIES} بعد ${Math.round(delayMs / 1000)} ثانية...`);
                                            await new Promise(r => setTimeout(r, delayMs));
                                            continue;
                                        }
                                        console.warn(`[audio-worker] Whisper rate limited after ${MAX_WHISPER_RETRIES} retries. Falling back to Gemini.`);
                                        break;
                                    }

                                    if (whisperRes.ok) {
                                        const whisperText = (await whisperRes.text()).trim();
                                        if (whisperText.length >= 50 && !whisperText.startsWith('{') && !whisperText.startsWith('<')) {
                                            fullTranscript = whisperText;
                                            console.log(`[audio-worker] ✅ Whisper transcription: ${fullTranscript.length} chars (attempt ${attempt + 1})`);
                                            break;
                                        }
                                        console.warn(`[audio-worker] Whisper returned invalid output (${whisperText.length} chars)`);
                                    } else {
                                        console.warn(`[audio-worker] Whisper error: ${whisperRes.status}`);
                                    }
                                    break; // Non-retryable error
                                } catch (attemptErr: any) {
                                    console.warn(`[audio-worker] Whisper attempt ${attempt + 1} error: ${attemptErr.message}`);
                                    if (attempt >= MAX_WHISPER_RETRIES - 1) break;
                                }
                            }
                        }
                    } catch (whisperErr: any) {
                        console.warn(`[audio-worker] ⚠️ Whisper pipeline error: ${whisperErr.message}`);
                    }
                }

                // ═══ FALLBACK: Gemini if Whisper failed or file too large ═══
                if (!fullTranscript || fullTranscript.trim().length < 50) {
                    if (!fileUri) {
                        throw new Error('Whisper failed and no gemini_file_uri available for Gemini fallback');
                    }

                    console.log(`[audio-worker] Falling back to Gemini transcription...`);
                    await updateProgress('جاري تفريغ النصوص بواسطة Gemini كبديل...');

                    try {
                        const geminiText = await transcribeWithGemini(fileUri, geminiKey);
                        if (geminiText && geminiText.trim().length >= 50) {
                            fullTranscript = geminiText;
                            console.log(`[audio-worker] ✅ Gemini fallback transcription: ${fullTranscript.length} chars`);
                        }
                    } catch (geminiErr: any) {
                        console.warn(`[audio-worker] ⚠️ Gemini transcription also failed: ${geminiErr.message}`);
                    }
                }

                if (!fullTranscript || fullTranscript.trim().length < 50) {
                    throw new Error(`فشل تفريغ الصوت — لم يرجع أي نص كافٍ من Whisper أو Gemini (${fullTranscript?.length || 0} حرف)`);
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

// ─── Shared: Save transcript and mark job completed ───
async function saveTranscriptAndComplete(
    supabase: any,
    lessonId: string,
    jobId: string,
    transcript: string,
    payload: any,
    updateProgress: (msg: string) => Promise<void>
) {
    // CRITICAL GUARD: Never save empty/garbage transcripts
    if (!transcript || transcript.trim().length < 50) {
        console.error(`[audio-worker] ❌ Transcript is empty or too short (${transcript?.length || 0} chars). NOT saving.`);
        await supabase.from('processing_queue').update({
            status: 'failed',
            error_message: 'لم يتم التعرف على أي محتوى صوتي — التفريغ فارغ أو قصير جداً',
            locked_by: null, locked_at: null
        }).eq('id', jobId);
        return;
    }

    await updateProgress('اكتمل التفريغ! جاري حفظ النصوص المفرغة...');

    const storagePath = `audio_transcripts/${lessonId}/raw_transcript.txt`;
    await supabase.storage.from('audio_transcripts').upload(storagePath, transcript, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

    console.log(`[audio-worker] Successfully transcribed and saved audio for lesson ${lessonId}. (${transcript.length} chars)`);

    await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

    // CRITICAL FIX: Delete any old completed/failed segment_lesson jobs BEFORE upserting.
    // Without this, ignoreDuplicates would silently skip the insert when a previous
    // segment_lesson job exists (e.g. from a PDF pipeline that ran before audio finished).
    // The old job may have completed without the audio transcript available.
    await supabase.from('processing_queue').delete()
        .eq('lesson_id', lessonId)
        .eq('job_type', 'segment_lesson')
        .in('status', ['completed', 'failed']);

    // Trigger segmentation (will now succeed even if segment_lesson ran before)
    await supabase.from('processing_queue').upsert({
        lesson_id: lessonId,
        job_type: 'segment_lesson',
        payload: { ...payload, stage: undefined, gemini_file_uri: undefined, gemini_file_name: undefined, poll_count: undefined },
        status: 'pending',
        dedupe_key: `lesson:${lessonId}:segment_lesson`
    }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
}
