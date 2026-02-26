import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { corsHeaders, jsonResponse, errorResponse } from '../_shared/utils.ts';
import { chunkText } from '../_shared/chunker.ts';

/**
 * Edge Function: ingest-file (Step-based execution)
 * Stages:
 * 1. pending_upload
 * 2. extracting_text
 * 3. saving_chunks 
 * 4. embedding_batch
 * 5. completed | failed
 */

const AUDIO_PROMPT = `أنت مفرّغ صوتي محترف ودقيق جداً متخصص في المحتوى الأكاديمي العربي.
حوّل كل الكلام في هذا التسجيل الصوتي إلى نص عربي مكتوب بأعلى دقة ممكنة.

⚠️ قواعد صارمة:
- فرّغ التسجيل كاملاً من أوله لآخره بدون توقف أو تخطي أي جزء
- اكتب كل كلمة بدون حذف أو اختصار أو تلخيص
- المصطلحات العلمية والأسماء الخاصة: اكتبها بدقة كما نُطقت
- الأرقام والتواريخ والمعادلات: اكتبها كما قالها المتحدث بالضبط
- الأمثلة والتمارين: اكتب كل مثال قاله المعلم بالكامل
- إذا كرر المعلم نقطة للتأكيد، اكتبها مرة واحدة وأضف [مُكرر للتأكيد]
- إذا كان هناك سؤال وجواب بين المعلم والطلاب، اكتب (المعلم: ...) و(طالب: ...)
- حافظ على الترتيب الزمني للشرح
- اكتب النص المُفرَّغ فقط بدون مقدمات أو تعليقات من عندك`;

const IMAGE_PROMPT = `أنت خبير في قراءة صور السبورة والملاحظات المكتوبة بخط اليد. استخرج كل النص الموجود في هذه الصورة.
القواعد:
- اكتب النص العربي كما هو بالضبط بدون تعديل
- إذا كانت هناك رسومات أو مخططات، صفها بإيجاز
- حافظ على ترتيب النص والعناوين
- لا تضف أي تعليقات أو شروحات من عندك
- أخرج النص المستخرج فقط`;

const PDF_PROMPT = `أنت خبير في استخراج النصوص العربية من ملفات PDF. اقرأ كل صفحة واستخرج النص كاملاً.
القواعد:
- استخرج كل النص بدقة
- حافظ على ترتيب الفقرات
- تجاهل الصور الزخرفية لكن صف الرسوم البيانية
- اكتب الأرقام والتواريخ كما هي
- لا تضف تعليقات`;

function getFileType(fileName: string, declaredType: string): 'pdf' | 'audio' | 'image' | 'text' {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (declaredType === 'text' || ext === 'txt') return 'text';
    if (ext === 'pdf' || declaredType === 'application/pdf') return 'pdf';
    if (declaredType === 'audio' || ['mp3', 'wav', 'mp4', 'm4a', 'ogg', 'webm'].includes(ext)) return 'audio';
    if (declaredType === 'image' || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
    return 'pdf';
}

function getMime(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'mp4': 'audio/mp4',
        'm4a': 'audio/mp4', 'ogg': 'audio/ogg', 'webm': 'audio/webm',
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp',
        'pdf': 'application/pdf'
    };
    return map[ext] || 'application/octet-stream';
}

// ─── Gemini API Calls ───────────────────────────────────

async function callGemini(apiKey: string, parts: any[], maxTokens = 65536): Promise<string> {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts }],
                        generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens }
                    })
                }
            );

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 429 || response.status >= 500) {
                    if (attempt < maxAttempts - 1) {
                        const baseDelay = Math.pow(2, attempt) * 2000;
                        const jitter = Math.random() * 1000;
                        // Cap at 20s to stay within 150s Edge Function wall clock limit
                        const delay = Math.min(baseDelay + jitter, 20000);
                        console.warn(`[Gemini] ${response.status} Error. Retrying in ${delay / 1000}s...`);
                        await new Promise(res => setTimeout(res, delay));
                        continue;
                    }
                }
                throw new Error(`Gemini: ${data.error?.message || response.status}`);
            }

            const resParts = data.candidates?.[0]?.content?.parts || [];
            return resParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
        } catch (error: any) {
            if (attempt < maxAttempts - 1 && (
                error.message.includes('fetch') ||
                error.message.includes('network') ||
                error.message.includes('429') ||
                error.message.includes('500') ||
                error.message.includes('503')
            )) {
                const baseDelay = Math.pow(2, attempt) * 2000;
                const jitter = Math.random() * 1000;
                const delay = Math.min(baseDelay + jitter, 20000);
                console.warn(`[Gemini] Network/server error (attempt ${attempt + 1}). Retrying in ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(res => setTimeout(res, delay));
                continue;
            }
            throw error;
        }
    }
    throw new Error('callGemini failed after max retries');
}

async function uploadToGeminiFiles(storageRes: Response, fileName: string, mimeType: string, apiKey: string): Promise<string> {
    const contentLength = storageRes.headers.get('content-length') || '0';

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
            body: JSON.stringify({ file: { displayName: fileName } })
        }
    );
    if (!startRes.ok) throw new Error(`File API start failed: ${startRes.status}`);
    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL allocated');

    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': contentLength,
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: storageRes.body
    });
    if (!uploadRes.ok) throw new Error(`File API upload failed: ${uploadRes.status}`);
    const fileInfo = await uploadRes.json();
    const fileUri = fileInfo.file?.uri;
    if (!fileUri) throw new Error('No file URI returned');

    const fileName2 = fileInfo.file?.name;
    for (let i = 0; i < 30; i++) {
        const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${apiKey}`);
        const status = await s.json();
        if (status.state === 'ACTIVE') return fileUri;
        if (status.state === 'FAILED') throw new Error('File processing failed on Gemini servers');
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('File processing timeout on Gemini');
}

// ─── Main Handler ───────────────────────────────────────

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: {
                ...corsHeaders,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Max-Age': '86400',
            }
        });
    }

    try {
        if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

        const body = await req.json();
        const { jobId } = body;

        if (!jobId) {
            return errorResponse('Missing jobId', 400);
        }

        const supabaseUrl = Deno.env.get('APP_SUPABASE_URL') || Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('APP_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
        const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';

        if (!supabaseUrl || !supabaseKey) return errorResponse('Missing Supabase config', 500);
        if (!geminiKey) return errorResponse('Missing GEMINI_API_KEY', 500);

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Fetch the job
        const { data: job, error: jobError } = await supabase
            .from('processing_queue')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return errorResponse('Job not found', 404);
        }

        const lessonId = job.lesson_id;
        let { stage, progress, attempt_count, gemini_file_uri, extraction_cursor, payload } = job;
        stage = stage || 'pending_upload';
        progress = progress || 0;
        extraction_cursor = extraction_cursor || 0;
        attempt_count = attempt_count || 0;

        const fileInfo = payload; // Contains filePath, contentHash, type, etc.
        const filePath = fileInfo.file_path;
        const contentHash = fileInfo.content_hash;
        const fileType = getFileType(filePath, fileInfo.type || 'unknown');

        console.log(`[Ingest DBG] Job ${jobId} | Stage: ${stage} | Progress: ${progress}%`);

        // Set to 'pending' + unlock so the orchestrator can re-invoke for the next stage.
        // The orchestrator only claims 'pending' jobs, so this is the handoff signal.
        const advanceStage = async (newStage: string, newProgress: number, extraUpdates: any = {}) => {
            const { error } = await supabase.from('processing_queue')
                .update({
                    stage: newStage,
                    progress: newProgress,
                    updated_at: new Date().toISOString(),
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    ...extraUpdates
                })
                .eq('id', jobId);
            if (error) throw new Error(`Failed to advance stage: ${error.message}`);
            return jsonResponse({ success: true, stage: newStage, progress: newProgress, status: 'pending' });
        };

        // Update progress/stage WITHOUT releasing the lock.
        // Use this when the Edge Function is still actively working on the job.
        // advanceStage() should only be used for genuine handoffs to the orchestrator.
        const updateProgress = async (newStage: string, newProgress: number) => {
            await supabase.from('processing_queue')
                .update({
                    stage: newStage,
                    progress: newProgress,
                    updated_at: new Date().toISOString()
                    // NO status/locked_by/locked_at change — job stays processing+locked
                })
                .eq('id', jobId);
        };

        const setFail = async (errMsg: string) => {
            await supabase.from('processing_queue').update({
                status: 'failed',
                stage: 'failed',
                error_message: errMsg,
                updated_at: new Date().toISOString()
            }).eq('id', jobId);

            await supabase.from('lessons')
                .update({ analysis_status: 'failed' })
                .eq('id', lessonId);

            return jsonResponse({ success: false, stage: 'failed', status: 'failed', error: errMsg });
        };

        const setComplete = async () => {
            await checkAndSpawnAnalysis();
            await supabase.from('processing_queue').update({
                status: 'completed',
                stage: 'completed',
                progress: 100,
                completed_at: new Date().toISOString()
            }).eq('id', jobId);
            return jsonResponse({ success: true, stage: 'completed', progress: 100, status: 'completed' });
        };

        const spawnNextAtomicJob = async (type: string, extraPayload: any = {}, dedupeKey?: string) => {
            const nextPayload = { ...payload, ...extraPayload };
            delete nextPayload.batches;
            delete nextPayload.summaryParts;

            const dKey = dedupeKey || `hash:${contentHash || lessonId}:${type}`;

            let { error: insertErr } = await supabase.from('processing_queue').insert({
                lesson_id: lessonId,
                job_type: type,
                payload: nextPayload,
                status: 'pending',
                stage: 'queued',
                dedupe_key: dKey
            });

            // If the job already exists (due to dedupe_key), ignore the insert error because it's working as intended
            if (insertErr && insertErr.code === '23505') {
                console.log(`[Ingest] Dedupe caught duplicate spawn: ${dKey}`);
            } else if (insertErr) {
                console.error(`[Ingest] Failed to spawn ${type}:`, insertErr);
            }
        };

        const checkAndSpawnAnalysis = async () => {
            const { count: pendingExtracts, error: countErr } = await supabase
                .from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lessonId)
                .in('job_type', [
                    'ingest_upload', 'ingest_extract', 'ingest_chunk',
                    'pdf_extract', 'audio_transcribe', 'image_ocr',
                    'extract_toc', 'build_lecture_segments', 'extract_text_range',
                    'ocr_range', 'chunk_lecture', 'embed_lecture', 'embed_sections',
                    'analyze_lecture'
                ])
                .in('status', ['pending', 'processing'])
                .neq('id', jobId);

            if (!countErr && pendingExtracts === 0) {
                // Prevent spawning analysis if one is already pending or completed
                const { data: existingAnalysis } = await supabase
                    .from('processing_queue')
                    .select('id')
                    .eq('lesson_id', lessonId)
                    .eq('job_type', 'generate_analysis')
                    .maybeSingle();

                if (!existingAnalysis) {
                    const { error: insertErr } = await supabase.from('processing_queue').insert({
                        lesson_id: lessonId,
                        job_type: 'generate_analysis',
                        status: 'pending'
                    });

                    if (!insertErr || insertErr.code === '23505') {
                        await supabase.from('lessons').update({ analysis_status: 'pending' }).eq('id', lessonId);
                    } else {
                        console.error('[Ingest] Failed to queue generate_analysis:', insertErr);
                    }
                }
            }
        };

        try {
            // ==========================================
            // ATOMIC JOB: ingest_upload
            // ==========================================
            if (job.job_type === 'ingest_upload') {
                await updateProgress('pending_upload', 10);

                // ═══ FRESH RE-ANALYSIS: Clean ALL old data for this lesson ═══
                // This ensures pressing "analyze" always starts from scratch.
                // No need to delete and re-upload files!
                try {
                    console.log(`[Ingest] 🧹 Cleaning old data for lesson ${lessonId}...`);

                    // 1. Delete old processing jobs (except current one AND other ingest_upload jobs)
                    // IMPORTANT: Do NOT delete other ingest_upload jobs — those are sibling files!
                    await supabase.from('processing_queue')
                        .delete()
                        .eq('lesson_id', lessonId)
                        .neq('id', jobId)
                        .neq('job_type', 'ingest_upload');

                    // 2. Delete old document sections
                    await supabase.from('document_sections')
                        .delete()
                        .eq('lesson_id', lessonId);

                    // 3. Delete old lecture analysis
                    await supabase.from('lecture_analysis')
                        .delete()
                        .eq('lesson_id', lessonId);

                    // 4. Delete old lecture segments
                    await supabase.from('lecture_segments')
                        .delete()
                        .eq('lesson_id', lessonId);

                    // 5. Delete old book analysis
                    await supabase.from('book_analysis')
                        .delete()
                        .eq('lesson_id', lessonId);

                    // 6. Clear old file hashes (so cache doesn't interfere)
                    await supabase.from('file_hashes')
                        .delete()
                        .eq('lesson_id', lessonId);

                    // 7. Reset lesson status
                    await supabase.from('lessons')
                        .update({ analysis_status: 'processing' })
                        .eq('id', lessonId);

                    console.log(`[Ingest] ✅ Old data cleaned. Starting fresh analysis.`);
                } catch (cleanErr: any) {
                    // Non-fatal: continue even if cleanup partially fails
                    console.warn(`[Ingest] ⚠️ Cleanup warning (non-fatal): ${cleanErr.message}`);
                }

                // Cache check for audio before uploading
                if (fileType === 'audio') {
                    const { data: cached } = await supabase.from('file_hashes').select('transcription')
                        .eq('content_hash', contentHash).maybeSingle();
                    if (cached?.transcription && cached.transcription.length > 100) {
                        console.log(`[Audio Cache] Found matching transcription for ${contentHash}`);
                        await spawnNextAtomicJob('ingest_chunk', {}); // Bypass extraction entirely
                        return await setComplete();
                    }
                }

                const { data: signData, error: signErr } = await supabase.storage.from('homework-uploads').createSignedUrl(filePath, 60);
                if (signErr || !signData) throw new Error(`Sign URL failed: ${signErr?.message}`);

                const storageRes = await fetch(signData.signedUrl);
                if (!storageRes.ok) throw new Error(`Fetch stream failed: ${storageRes.statusText}`);

                const fileName = filePath.split('/').pop() || 'file';
                const mimeType = getMime(fileName);

                console.log(`[Ingest] Uploading ${filePath} to Gemini...`);
                const fileUri = await uploadToGeminiFiles(storageRes, fileName, mimeType, geminiKey);

                if (fileType === 'pdf') {
                    await spawnNextAtomicJob('extract_toc', { gemini_file_uri: fileUri });
                } else {
                    await spawnNextAtomicJob('ingest_extract', { gemini_file_uri: fileUri });
                }
                return await setComplete();
            }

            // ==========================================
            // ATOMIC JOB: extract_toc (For PDFs)
            // ==========================================
            if (job.job_type === 'extract_toc') {
                await updateProgress('extracting_toc', 10);
                const activeUri = gemini_file_uri || fileInfo.gemini_file_uri;
                if (!activeUri) throw new Error("Missing gemini_file_uri");

                const mimeType = getMime(filePath);
                const filePart = { fileData: { fileUri: activeUri, mimeType } };

                const prompt = `أنت خبير أكاديمي محترف في استخراج فهارس الكتب.
ابحث في هذا الكتاب بأكمله (خاصة الصفحات الأولى) عن "الفهرس" (Table of Contents) أو قائمة الدروس والمحاضرات.
ثم أعطني قائمة بالدروس مرتبة، مع **رقم الصفحة الفعلي الذي يبدأ فيه كل درس**.

أخرج النتيجة بصيغة JSON حصراً بهذا الشكل:
{
  "lectures": [
    { "title": "عنوان المحاضرة الأولى", "start_page": 5 },
    { "title": "عنوان المحاضرة الثانية", "start_page": 20 }
  ]
}

لا تضف أي نص قبل أو بعد الـ JSON.`;

                console.log(`[Ingest] Extracting TOC...`);
                const resultText = await callGemini(geminiKey, [{ text: prompt }, filePart]);

                let parsed = null;
                try {
                    let text = resultText.trim();
                    if (text.startsWith('\`\`\`json')) text = text.replace(/^\`\`\`json/, '').replace(/\`\`\`$/, '').trim();
                    else if (text.startsWith('\`\`\`')) text = text.replace(/^\`\`\`/, '').replace(/\`\`\`$/, '').trim();
                    parsed = JSON.parse(text);
                } catch (e) {
                    console.warn('[Ingest] TOC parsing failed', e);
                    // Fallback empty TOC
                    parsed = { lectures: [] };
                }

                if (!parsed || !parsed.lectures || parsed.lectures.length === 0) {
                    parsed = { lectures: [{ title: 'محتوى الكتاب (لم يتم العثور على فهرس)', start_page: 1 }] };
                }

                await spawnNextAtomicJob('build_lecture_segments', { toc: parsed, gemini_file_uri: activeUri });
                return await setComplete();
            }

            // ==========================================
            // ATOMIC JOB: build_lecture_segments
            // ==========================================
            if (job.job_type === 'build_lecture_segments') {
                await updateProgress('building_segments', 20);
                const toc = payload.toc;
                const cachedGeminiUri = payload.gemini_file_uri;

                const lectures = toc.lectures.map((l: any, idx: number) => {
                    const start_page = l.start_page || 1;
                    const next = toc.lectures[idx + 1];
                    const page_to = next && next.start_page ? next.start_page - 1 : start_page + 100;
                    return {
                        lesson_id: lessonId,
                        title: l.title,
                        page_from: start_page,
                        page_to: page_to,
                        confidence: 0.95
                    };
                });

                const { data: inserted, error } = await supabase.from('lecture_segments')
                    .insert(lectures)
                    .select('id, page_from, page_to');

                if (error) throw new Error(`Failed to save lecture segments: ${error.message}`);

                if (inserted && inserted.length > 0) {
                    if (cachedGeminiUri) {
                        // ═══ FAST PATH: Spawn ALL OCR jobs upfront using cached Gemini URI ═══
                        // This bypasses Vercel entirely! OCR runs on Edge Function (no 10s limit)
                        console.log(`[Ingest] Fast path: spawning OCR jobs for ${inserted.length} lectures using cached Gemini URI`);

                        for (const lecture of inserted) {
                            // Spawn ocr_range jobs for every 10-page batch
                            for (let p = lecture.page_from; p <= lecture.page_to; p += 10) {
                                const pages: number[] = [];
                                for (let pp = p; pp <= Math.min(p + 9, lecture.page_to); pp++) {
                                    pages.push(pp);
                                }

                                await spawnNextAtomicJob('ocr_range', {
                                    lecture_id: lecture.id,
                                    pages,
                                    gemini_file_uri: cachedGeminiUri,
                                    content_hash: payload.content_hash
                                }, `lesson:${lessonId}:ocr_range:lec_${lecture.id}:p_${pages[0]}`);
                            }

                            // Spawn chunk_lecture barrier for this lecture
                            await spawnNextAtomicJob('chunk_lecture', {
                                lecture_id: lecture.id
                            }, `lesson:${lessonId}:chunk_lecture:lec_${lecture.id}`);
                        }
                    } else {
                        // ═══ LEGACY PATH: Use extract_text_range on Vercel (chains sequentially) ═══
                        const firstLecture = inserted[0];
                        await spawnNextAtomicJob('extract_text_range', {
                            lecture_id: firstLecture.id,
                            page: firstLecture.page_from
                        }, `lecture:extract_text:${firstLecture.id}:page_${firstLecture.page_from}`);
                    }
                }

                return await setComplete();
            }

            // ==========================================
            // ATOMIC JOB: ocr_range
            // ==========================================
            if (job.job_type === 'ocr_range') {
                await updateProgress('ocr_range', 10);
                const { cropped_file_path, content_hash, lecture_id, pages, gemini_file_uri: cachedUri } = payload;

                if (!cachedUri && !cropped_file_path) throw new Error("Missing both gemini_file_uri and cropped_file_path");

                console.log(`[Ingest] OCR starting for Lecture ${lecture_id}, Pages: ${pages.join(',')}`);

                let fileUri: string;
                let usedCachedUri = false;

                if (cachedUri) {
                    // ═══ FAST PATH: Use pre-uploaded Gemini URI (no download/crop/upload!) ═══
                    console.log(`[Ingest] Using cached Gemini URI — zero download overhead`);
                    fileUri = cachedUri;
                    usedCachedUri = true;
                } else {
                    // ═══ LEGACY PATH: Download cropped PDF from Storage, upload to Gemini ═══
                    const { data: signData, error: signErr } = await supabase.storage.from('homework-uploads').createSignedUrl(cropped_file_path, 60);
                    if (signErr || !signData) throw new Error(`Sign URL failed for OCR: ${signErr?.message}`);

                    const storageRes = await fetch(signData.signedUrl);
                    if (!storageRes.ok) throw new Error(`Fetch stream failed: ${storageRes.statusText}`);

                    const fileName = cropped_file_path.split('/').pop() || 'ocr-chunk.pdf';
                    fileUri = await uploadToGeminiFiles(storageRes, fileName, 'application/pdf', geminiKey);
                }

                // Build page-specific prompt for cached URI, or generic for cropped
                const prompt = usedCachedUri
                    ? `أنت خبير في دقة استخراج النصوص من الكتب المصورة (Scanned Books).
مطلوب منك استخراج النص من الصفحات ${pages.join(' و ')} فقط من هذا الملف.

⚠️ تعليمات صارمة:
- استخرج النص من الصفحات المطلوبة فقط (${pages[0]} إلى ${pages[pages.length - 1]})
- لا تقرأ أي صفحات أخرى
- اكتب النص بالكامل كما هو مع الحفاظ على التشكيل والفقرات
- قم بتنظيف النص وإزالة أي تكرار غير طبيعي ناتج عن المسح الضوئي
- لا تضف أي تعليقات أو هوامش من عندك، فقط النص المستخرج الصافي والصحيح إملائياً`
                    : `أنت خبير في دقة استخراج النصوص من الكتب المصورة (Scanned Books).
استخرج كل النص الموجود في هذه الصفحات المعروضة أمامك، واكتبه بالكامل كما هو مع الحفاظ على التشكيل والفقرات.
مهم جداً: قم بتنظيف النص وإزالة أي تكرار غير طبيعي للحروف ناتج عن المسح الضوئي (مثلاً إذا وجدت "اللممححااضضررة" صححها لتصبح "المحاضرة").
لا تضف أي تعليقات أو هوامش من عندك، فقط النص المستخرج الصافي والصحيح إملائياً.`;

                const filePart = { fileData: { fileUri, mimeType: 'application/pdf' } };
                const resultText = await callGemini(geminiKey, [{ text: prompt }, filePart]);

                if (!resultText || resultText.length < 10) {
                    console.warn(`[Ingest] OCR returned very short text for pages ${pages.join(',')}`);
                } else {
                    console.log(`[Ingest] OCR succeeded! Length: ${resultText.length} chars for ${pages.length} pages`);
                }

                // Save to document_sections
                const physicalPage = pages[0];
                const { error: insErr } = await supabase.from('document_sections').insert({
                    lesson_id: lessonId,
                    lecture_id: lecture_id,
                    page: physicalPage,
                    content: resultText.trim(),
                    source_type: 'pdf',
                    source_file_id: fileInfo.file_path,
                    metadata: { extraction_method: usedCachedUri ? 'gemini-ocr-cached' : 'gemini-ocr', content_hash: content_hash }
                });

                if (insErr) throw new Error(`Failed to save OCR section: ${insErr.message}`);

                // Clean up the temp cropped file (only if we used legacy path)
                if (cropped_file_path) {
                    await supabase.storage.from('homework-uploads').remove([cropped_file_path]);
                }

                return await setComplete();
            }

            // ==========================================
            // ATOMIC JOB: chunk_lecture
            // ==========================================
            if (job.job_type === 'chunk_lecture') {
                const { lecture_id } = payload;

                // 1. Wait until NO extraction jobs are running for this lecture
                const { count, error: countErr } = await supabase.from('processing_queue')
                    .select('*', { count: 'exact', head: true })
                    .eq('lesson_id', lessonId)
                    .in('job_type', ['extract_text_range', 'ocr_range'])
                    .in('status', ['pending', 'processing'])
                    .contains('payload', JSON.stringify({ lecture_id }));

                if (count && count > 0) {
                    console.log(`[Ingest] Waiting for ${count} extraction jobs to finish for lecture ${lecture_id}`);
                    // Unlock the job and yield, so orchestrator picks it up later
                    await supabase.from('processing_queue').update({
                        status: 'pending',
                        locked_by: null,
                        locked_at: null,
                        attempt_count: 0 // Reset attempt to not fail
                    }).eq('id', jobId);
                    return jsonResponse({ success: true, stage: 'waiting', status: 'pending' });
                }

                await updateProgress('chunking_lecture', 50);

                // 2. Group text and chunk it
                const { data: sections } = await supabase.from('document_sections')
                    .select('id, content')
                    .eq('lecture_id', lecture_id)
                    .order('page', { ascending: true });

                const fullText = sections?.map((s: any) => s.content).join('\n\n') || '';
                let chunksCreatedCount = 0;

                if (fullText.trim().length > 0) {
                    // Wipe the raw page blocks so we can replace them with clean chunks
                    await supabase.from('document_sections')
                        .delete()
                        .eq('lecture_id', lecture_id);

                    const chunks = chunkText(fullText);
                    const BATCH_SIZE = 30;
                    let currentBatch = [];

                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        currentBatch.push({
                            lesson_id: lessonId,
                            lecture_id: lecture_id, // keep the connection!
                            content: chunk.content,
                            source_type: 'pdf',
                            source_file_id: fileInfo.file_path,
                            chunk_index: chunk.chunkIndex,
                            metadata: {
                                start_char: chunk.metadata.startChar,
                                end_char: chunk.metadata.endChar,
                                token_estimate: chunk.metadata.tokenEstimate
                            }
                        });

                        if (currentBatch.length === BATCH_SIZE || i === chunks.length - 1) {
                            const { error: insertErr } = await supabase.from('document_sections').insert(currentBatch);
                            if (insertErr) throw new Error(`Insert chunks failed: ${insertErr.message}`);
                            chunksCreatedCount += currentBatch.length;
                            currentBatch = [];
                        }
                    }
                }

                console.log(`[Ingest] Chunking complete for ${lecture_id}. Created ${chunksCreatedCount} chunks.`);

                // Check Minimum Extracted Content Coverage
                const { data: lecSeg } = await supabase.from('lecture_segments')
                    .select('page_from, page_to').eq('id', lecture_id).single();

                if (lecSeg) {
                    const totalPages = Math.max(1, lecSeg.page_to - lecSeg.page_from + 1);
                    const EXPECTED_MIN_CHARS_PER_PAGE = 200; // Lowered for scanned Arabic PDFs
                    const expectedTotal = totalPages * EXPECTED_MIN_CHARS_PER_PAGE;
                    const extractedTotal = fullText.trim().length;
                    const coveragePercent = Math.round((extractedTotal / Math.max(1, expectedTotal)) * 100);

                    console.log(`[Ingest] Coverage: ${extractedTotal} chars extracted / ~${expectedTotal} expected (${coveragePercent}%) for ${totalPages} pages`);

                    if (extractedTotal < (expectedTotal * 0.3)) { // Below 30% = hard fail
                        throw new Error(`Insufficient extracted content. OCR coverage too low: ${coveragePercent}% (${extractedTotal} chars / expected ~${expectedTotal}).`);
                    } else if (coveragePercent < 60) {
                        console.warn(`[Ingest] ⚠️ Low coverage (${coveragePercent}%). Analysis may be incomplete for lecture ${lecture_id}.`);
                    }
                }

                // 3. Spawn analyze_lecture for this lecture
                await spawnNextAtomicJob('analyze_lecture', { lecture_id }, `lesson:${lessonId}:analyze_lecture:lec_${lecture_id}`);

                // 4. Auto-cleanup: Delete the original PDF from Supabase Storage
                //    to free space (critical for 1GB free tier limit).
                //    The Gemini File URI is already cached for OCR, so the original is no longer needed.
                if (fileInfo?.file_path) {
                    try {
                        // Check if ALL chunk_lecture jobs for this lesson are done
                        const { count: pendingChunks } = await supabase.from('processing_queue')
                            .select('*', { count: 'exact', head: true })
                            .eq('lesson_id', lessonId)
                            .eq('job_type', 'chunk_lecture')
                            .in('status', ['pending', 'processing'])
                            .neq('id', jobId);

                        if (!pendingChunks || pendingChunks === 0) {
                            console.log(`[Ingest] 🗑️ All chunks done. Deleting original PDF to free storage: ${fileInfo.file_path}`);
                            await supabase.storage.from('homework-uploads').remove([fileInfo.file_path]);
                            // Also clean up any temp OCR files
                            const { data: tempFiles } = await supabase.storage.from('homework-uploads').list(`temp-ocr/${lessonId}`);
                            if (tempFiles && tempFiles.length > 0) {
                                const filesToRemove = tempFiles.map(f => `temp-ocr/${lessonId}/${f.name}`);
                                await supabase.storage.from('homework-uploads').remove(filesToRemove);
                                console.log(`[Ingest] 🗑️ Cleaned up ${filesToRemove.length} temp OCR files`);
                            }
                        }
                    } catch (cleanErr: any) {
                        // Non-fatal: don't fail the job just because cleanup failed
                        console.warn(`[Ingest] ⚠️ Storage cleanup failed (non-fatal): ${cleanErr.message}`);
                    }
                }

                return await setComplete();
            }

            // ==========================================
            // ATOMIC JOB: ingest_extract
            // ==========================================
            if (job.job_type === 'ingest_extract') {
                await updateProgress('extracting_text', 10);
                if (!gemini_file_uri && !fileInfo.gemini_file_uri) throw new Error("Missing gemini_file_uri for extraction");

                const activeUri = gemini_file_uri || fileInfo.gemini_file_uri;

                let prompt = PDF_PROMPT;
                if (fileType === 'audio') prompt = AUDIO_PROMPT;
                if (fileType === 'image') prompt = IMAGE_PROMPT;

                const mimeType = getMime(filePath);
                const filePart = { fileData: { fileUri: activeUri, mimeType } };

                console.log(`[Ingest] Extracting text using Gemini...`);
                let text = '';

                if (fileType === 'audio') {
                    // ═══ SMART AUDIO TRANSCRIPTION (150s wall-clock safe) ═══
                    // Strategy:
                    // 1. Try full transcription (1 Gemini call, ~60s)
                    // 2. If truncated (<20K chars), spawn a 2nd job for the rest
                    // This keeps each Edge Function execution under 150s.

                    const audioPartNum = payload.audio_part || 1; // 1 = full/firstHalf, 2 = secondHalf

                    if (audioPartNum === 1) {
                        // First attempt: full transcription
                        try {
                            text = await callGemini(geminiKey, [{ text: AUDIO_PROMPT }, filePart]);
                            console.log(`[Ingest] Full audio transcription: ${text.length} chars`);
                        } catch (e: any) {
                            console.warn(`[Ingest] Full transcription failed: ${e.message}`);
                        }

                        // Fallback with simpler prompt
                        if (text.length < 50) {
                            try {
                                text = await callGemini(geminiKey, [{ text: 'استمع للتسجيل الصوتي التالي بعناية وحوّله إلى نص عربي مكتوب. اكتب كل ما يقوله المتحدث بالضبط. اكتب النص فقط.' }, filePart]);
                            } catch (e: any) {
                                console.warn(`[Ingest] Fallback transcription failed: ${e.message}`);
                            }
                        }

                        // Check if output looks truncated (heuristic: long audio should produce 20K+ chars)
                        if (text.length >= 50 && text.length < 20000) {
                            console.log(`[Ingest] ⚠️ Transcription may be truncated (${text.length} chars). Spawning part 2...`);

                            // Save part 1 immediately
                            await supabase.from('file_hashes')
                                .update({ transcription: text })
                                .eq('content_hash', contentHash);

                            // Spawn a follow-up job for the second half
                            await spawnNextAtomicJob('ingest_extract', {
                                gemini_file_uri: activeUri,
                                audio_part: 2
                            }, `lesson:${lessonId}:ingest_extract_part2`);

                            return await setComplete();
                        }
                    } else if (audioPartNum === 2) {
                        // Second half transcription
                        const secondHalfPrompt = `أنت مفرّغ صوتي محترف ودقيق جداً.
حوّل النصف الثاني من هذا التسجيل الصوتي إلى نص عربي مكتوب.

⚠️ قواعد صارمة:
- فرّغ النصف الثاني فقط (من المنتصف تقريباً حتى نهاية التسجيل)
- لا تكرر ما جاء في النصف الأول
- اكتب كل كلمة بدون حذف أو اختصار
- اكتب النص المُفرَّغ فقط بدون مقدمات`;

                        try {
                            const part2Text = await callGemini(geminiKey, [{ text: secondHalfPrompt }, filePart]);
                            console.log(`[Ingest] Part 2 (second half): ${part2Text.length} chars`);

                            // Fetch existing part 1 and combine
                            const { data: existing } = await supabase.from('file_hashes')
                                .select('transcription').eq('content_hash', contentHash).single();
                            const part1 = existing?.transcription || '';
                            text = (part1 + '\n\n' + part2Text).trim();
                            console.log(`[Ingest] Combined transcription: ${text.length} chars`);
                        } catch (e: any) {
                            console.warn(`[Ingest] Part 2 failed: ${e.message}. Using part 1 only.`);
                            // Fall back to part 1 only
                            const { data: existing } = await supabase.from('file_hashes')
                                .select('transcription').eq('content_hash', contentHash).single();
                            text = existing?.transcription || '';
                        }
                    }
                } else {
                    text = await callGemini(geminiKey, [{ text: prompt }, filePart]);
                }

                if (!text || text.length < 10) {
                    if (fileType !== 'image') throw new Error(`Extraction failed, response too short: ${text?.length} chars`);
                }

                // Save text directly to file_hashes.transcription
                const { error: updErr } = await supabase.from('file_hashes')
                    .update({ transcription: text })
                    .eq('content_hash', contentHash);

                if (updErr) throw new Error(`Save transcription failed: ${updErr.message}`);

                // Auto-cleanup: Delete original audio/pdf file from Storage to free space (1GB limit)
                if (fileType === 'audio' && fileInfo?.file_path) {
                    try {
                        console.log(`[Ingest] 🗑️ Deleting original audio to free storage: ${fileInfo.file_path}`);
                        await supabase.storage.from('homework-uploads').remove([fileInfo.file_path]);
                    } catch (cleanErr: any) {
                        console.warn(`[Ingest] ⚠️ Audio cleanup failed (non-fatal): ${cleanErr.message}`);
                    }
                }

                if (fileType === 'image') {
                    await checkAndSpawnAnalysis(); // no chunking needed for images
                } else {
                    await spawnNextAtomicJob('ingest_chunk', {});
                }

                return await setComplete();
            }

            // ==========================================
            // ATOMIC JOB: ingest_chunk
            // ==========================================
            if (job.job_type === 'ingest_chunk') {
                // Fetch the heavy text safely from file_hashes
                const { data: hashData } = await supabase.from('file_hashes').select('transcription').eq('content_hash', contentHash).single();
                const text = hashData?.transcription || '';

                if (!text) {
                    console.warn(`[Ingest] No transcription found in file_hashes for chunking.`);
                    if (fileType === 'image') {
                        await checkAndSpawnAnalysis();
                        return await setComplete();
                    }
                    throw new Error("Missing extracted text in file_hashes");
                }

                if (stage === 'pending_upload') stage = 'saving_chunks';

                // --- STAGE: saving_chunks ---
                if (stage === 'saving_chunks') {
                    console.log(`[Ingest] Chunking text of length ${text.length}`);

                    if (extraction_cursor === 0) {
                        await supabase.from('document_sections')
                            .delete()
                            .eq('lesson_id', lessonId)
                            .eq('source_type', fileType);
                    }

                    const chunks = chunkText(text);
                    const BATCH_SIZE = 30;

                    let currentBatch = [];
                    for (let i = extraction_cursor; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        currentBatch.push({
                            lesson_id: lessonId,
                            content: chunk.content,
                            source_type: fileType,
                            source_file_id: filePath,
                            chunk_index: chunk.chunkIndex,
                            metadata: {
                                content_hash: contentHash,
                                start_char: chunk.metadata.startChar,
                                end_char: chunk.metadata.endChar,
                                token_estimate: chunk.metadata.tokenEstimate
                            }
                        });

                        if (currentBatch.length === BATCH_SIZE || i === chunks.length - 1) {
                            const { error: insertErr } = await supabase.from('document_sections').insert(currentBatch);
                            if (insertErr) throw new Error(`Insert chunks failed: ${insertErr.message}`);

                            currentBatch = [];
                            const nextCursor = i + 1;
                            if (nextCursor < chunks.length) {
                                const prog = Math.floor((nextCursor / chunks.length) * 50); // 0-50% progress for chunking
                                return await advanceStage('saving_chunks', prog, { extraction_cursor: nextCursor });
                            }
                        }
                    }

                    return await advanceStage('embedding_batch', 50, { extraction_cursor: 0 }); // Switch to embeddings
                }

                // --- STAGE: embedding_batch ---
                if (stage === 'embedding_batch') {
                    if (!openaiKey) {
                        console.warn('[Ingest] No OPENAI_API_KEY, skipping embeddings');
                        await checkAndSpawnAnalysis();
                        return await setComplete();
                    }

                    const { data: sections } = await supabase.from('document_sections')
                        .select('id, content')
                        .eq('lesson_id', lessonId)
                        .is('embedding', null)
                        .limit(25);

                    if (!sections || sections.length === 0) {
                        console.log('[Ingest] All chunks embedded. Done.');
                        await checkAndSpawnAnalysis();
                        return await setComplete();
                    }

                    console.log(`[Ingest] Embedding batch of ${sections.length} chunks`);
                    const texts = sections.map((s: any) => s.content);
                    const res = await fetch('https://api.openai.com/v1/embeddings', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
                    });

                    if (!res.ok) throw new Error(`OpenAI failed: ${res.statusText}`);
                    const data = await res.json();

                    for (let j = 0; j < data.data.length; j++) {
                        await supabase.from('document_sections')
                            .update({ embedding: JSON.stringify(data.data[j].embedding) })
                            .eq('id', sections[j].id);
                    }

                    // Progress estimate logic could go here, for now stay in embedding_batch until sections === 0
                    return await advanceStage('embedding_batch', 85);
                }
            }

            // Catch-all for old uncompleted monolithic jobs to gracefully fail them.
            if (['pdf_extract', 'audio_transcribe', 'image_ocr'].includes(job.job_type)) {
                throw new Error(`Legacy job type ${job.job_type} is no longer supported by the Step engine. Job marked as failed.`);
            }

            // Should not reach here if completed
            if (stage === 'completed' || stage === 'failed') {
                return jsonResponse({ success: true, stage, status: stage });
            }

            throw new Error(`Unknown stage: ${stage}`);

        } catch (e: any) {
            console.error(`[Ingest DBG] Error in ${stage}: ${e.message}`);

            // Fast fail if too many attempts
            if (attempt_count >= 5) {
                if (job.job_type === 'ocr_range') {
                    // Degraded mode: mark as partial / completed to allow chunk_lecture to proceed
                    await supabase.from('processing_queue').update({
                        status: 'completed',
                        stage: 'partial',
                        error_message: 'Max retries reached. OCR failed for this chunk.',
                        updated_at: new Date().toISOString()
                    }).eq('id', jobId);
                    return jsonResponse({ success: true, stage: 'partial', status: 'completed', message: 'ocr fallback applied' });
                }
                return await setFail(e.message);
            } else {
                // Determine backoff inside Edge function so we explicitly set next_retry_at
                const baseDelay = Math.pow(2, attempt_count) * 2000;
                const delayMs = Math.min(baseDelay, 45000);
                const nextRetry = new Date(Date.now() + delayMs).toISOString();

                // Increment attempt and UNLOCK the job so it can be retried
                await supabase.from('processing_queue').update({
                    attempt_count: attempt_count + 1,
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: nextRetry,
                    error_message: e.message
                }).eq('id', jobId);

                return jsonResponse({ success: false, stage, status: 'pending', error: e.message, attempt: attempt_count + 1 });
            }
        }

    } catch (error: any) {
        console.error('Ingest Edge Fatal Error:', error);
        return new Response(
            JSON.stringify({ error: error.message || 'Ingestion handler crashed', stack: error.stack }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
