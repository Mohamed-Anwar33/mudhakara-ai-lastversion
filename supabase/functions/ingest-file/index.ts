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
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const resParts = data.candidates?.[0]?.content?.parts || [];
    return resParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
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

        const advanceStage = async (newStage: string, newProgress: number, extraUpdates: any = {}) => {
            const { error } = await supabase.from('processing_queue')
                .update({
                    stage: newStage,
                    progress: newProgress,
                    updated_at: new Date().toISOString(),
                    status: 'pending',     // unlock for next step
                    locked_by: null,       // unlock for next step
                    locked_at: null,       // unlock for next step
                    ...extraUpdates
                })
                .eq('id', jobId);
            if (error) throw new Error(`Failed to advance stage: ${error.message}`);
            return jsonResponse({ success: true, stage: newStage, progress: newProgress, status: 'pending' });
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
            await supabase.from('processing_queue').update({
                status: 'completed',
                stage: 'completed',
                progress: 100,
                completed_at: new Date().toISOString()
            }).eq('id', jobId);

            // Check if this was the last extraction job
            const { count: pendingExtracts, error: countErr } = await supabase
                .from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lessonId)
                .in('job_type', ['pdf_extract', 'audio_transcribe', 'image_ocr'])
                .in('status', ['pending', 'processing'])
                .neq('id', jobId); // Exclude the current job since it might still be fetching as processing

            if (!countErr && pendingExtracts === 0) {
                // No extractions pending, safe to queue analysis
                const { error: insertErr } = await supabase.from('processing_queue').insert({
                    lesson_id: lessonId,
                    job_type: 'generate_analysis',
                    status: 'pending'
                });

                if (!insertErr || insertErr.code === '23505') {
                    // Update lesson status if inserted successfully or already exists
                    await supabase
                        .from('lessons')
                        .update({ analysis_status: 'pending' })
                        .eq('id', lessonId);
                } else {
                    console.error('[Ingest] Failed to queue generate_analysis:', insertErr);
                }
            }

            return jsonResponse({ success: true, stage: 'completed', progress: 100, status: 'completed' });
        };

        try {
            // ==========================================
            // STAGE 1: upload_to_gemini
            // ==========================================
            if (stage === 'pending_upload' || stage === 'uploaded_to_gemini') {
                if (!gemini_file_uri) {
                    // Check local cache first for audio
                    if (fileType === 'audio') {
                        const { data: cached } = await supabase.from('file_hashes').select('transcription')
                            .eq('content_hash', contentHash).maybeSingle();
                        if (cached?.transcription && cached.transcription.length > 100) {
                            console.log(`[Audio Cache] Found matching transcription for ${contentHash}`);
                            await supabase.from('file_hashes').update({ transcription: cached.transcription }).eq('content_hash', contentHash);
                            // We have the text! Let's save it directly to a temp table or payload so the next stage can chunk it.
                            // Actually, let's just create chunks immediately if it's cached, as a fast track.
                            return await advanceStage('saving_chunks', 40, { payload: { ...fileInfo, extractedText: cached.transcription } });
                        }
                    }

                    // Otherwise, upload to Gemini
                    const { data: signData, error: signErr } = await supabase.storage.from('homework-uploads').createSignedUrl(filePath, 60);
                    if (signErr || !signData) throw new Error(`Sign URL failed: ${signErr?.message}`);

                    const storageRes = await fetch(signData.signedUrl);
                    if (!storageRes.ok) throw new Error(`Fetch stream failed: ${storageRes.statusText}`);

                    const fileName = filePath.split('/').pop() || 'file';
                    const mimeType = getMime(fileName);

                    console.log(`[Ingest] Uploading ${filePath} to Gemini...`);
                    const fileUri = await uploadToGeminiFiles(storageRes, fileName, mimeType, geminiKey);

                    return await advanceStage('extracting_text', 20, { gemini_file_uri: fileUri });
                } else {
                    return await advanceStage('extracting_text', 20);
                }
            }

            // ==========================================
            // STAGE 2: extracting_text
            // ==========================================
            if (stage === 'extracting_text') {
                if (!gemini_file_uri) throw new Error("Missing gemini_file_uri for extraction");

                let prompt = PDF_PROMPT;
                if (fileType === 'audio') prompt = AUDIO_PROMPT;
                if (fileType === 'image') prompt = IMAGE_PROMPT;

                const mimeType = getMime(filePath);
                const filePart = { fileData: { fileUri: gemini_file_uri, mimeType } };

                console.log(`[Ingest] Extracting text using Gemini...`);
                let text = '';

                if (fileType === 'audio') {
                    // Audio prompt array fallback logic
                    const prompts = [AUDIO_PROMPT, 'استمع للتسجيل الصوتي التالي بعناية وحوّله إلى نص عربي مكتوب. اكتب كل ما يقوله المتحدث بالضبط. اكتب النص فقط.'];
                    for (const p of prompts) {
                        try {
                            text = await callGemini(geminiKey, [{ text: p }, filePart]);
                            if (text.length >= 50) break;
                        } catch (e: any) { console.warn(`Audio gemini attempt failed: ${e.message}`); }
                    }
                } else {
                    text = await callGemini(geminiKey, [{ text: prompt }, filePart]);
                }

                if (!text || text.length < 10) {
                    if (fileType !== 'image') throw new Error(`Extraction failed, response too short: ${text?.length} chars`);
                }

                if (fileType === 'audio') {
                    await supabase.from('file_hashes').upsert({ content_hash: contentHash, transcription: text });
                }

                // Append text to the payload to survive this step boundary
                const newPayload = { ...fileInfo, extractedText: text };
                return await advanceStage('saving_chunks', 40, { payload: newPayload });
            }

            // ==========================================
            // STAGE 3: saving_chunks
            // ==========================================
            if (stage === 'saving_chunks') {
                const text = fileInfo.extractedText || '';
                if (!text) {
                    console.warn(`[Ingest] No extractedText in payload at saving_chunks stage! Marking complete if empty image.`);
                    if (fileType === 'image') return await setComplete();
                    throw new Error("Missing extractedText in job payload");
                }

                console.log(`[Ingest] Chunking text of length ${text.length}`);

                // Clear existing sections ONLY if extraction_cursor is 0
                if (extraction_cursor === 0) {
                    await supabase.from('document_sections')
                        .delete()
                        .eq('lesson_id', lessonId)
                        .eq('source_type', fileType);
                }

                const chunks = chunkText(text);
                const BATCH_SIZE = 30; // 30 chunks per step max

                let currentBatch = [];
                let iterCount = 0;

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

                        iterCount += currentBatch.length;
                        currentBatch = [];

                        // We successfully saved a batch. Return and continue on next Vercel ping.
                        const nextCursor = i + 1;
                        if (nextCursor < chunks.length) {
                            const prog = Math.floor(40 + ((nextCursor / chunks.length) * 30)); // 40-70%
                            return await advanceStage('saving_chunks', prog, { extraction_cursor: nextCursor });
                        }
                    }
                }

                // Finished all chunks! Remove the bulky text from payload to save DB size.
                delete fileInfo.extractedText;
                return await advanceStage('embedding_batch', 75, { payload: fileInfo, extraction_cursor: 0 });
            }

            // ==========================================
            // STAGE 4: embedding_batch
            // ==========================================
            if (stage === 'embedding_batch') {
                if (!openaiKey) {
                    console.warn('[Ingest] No OPENAI_API_KEY, skipping embeddings');
                    return await setComplete();
                }

                const { data: sections } = await supabase.from('document_sections')
                    .select('id, content')
                    .eq('lesson_id', lessonId)
                    .is('embedding', null)
                    .limit(25); // smaller batches for 20s cap

                if (!sections || sections.length === 0) {
                    console.log('[Ingest] All chunks embedded. Done.');
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

                return await advanceStage('embedding_batch', 85); // Stay in this stage until limit returns 0
            }

            // Should not reach here if completed
            if (stage === 'completed' || stage === 'failed') {
                return jsonResponse({ success: true, stage, status: stage });
            }

            throw new Error(`Unknown stage: ${stage}`);

        } catch (e: any) {
            console.error(`[Ingest DBG] Error in ${stage}: ${e.message}`);

            // Fast fail if too many attempts
            if (attempt_count >= 3) {
                return await setFail(e.message);
            } else {
                // Increment attempt
                await supabase.from('processing_queue').update({ attempt_count: attempt_count + 1 }).eq('id', jobId);
                return jsonResponse({ success: false, stage, status: 'processing', error: e.message, attempt: attempt_count + 1 });
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
