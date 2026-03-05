
import express from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { processPdfJob } from './_lib/pdf-processor.js';
import { processAudioJob } from './_lib/audio-processor.js';
import { processImageJob } from './_lib/image-processor.js';
import { generateLessonAnalysis } from './_lib/analysis.js';
import { embedLessonSections } from './_lib/embeddings.js';
import { segmentBook } from './_lib/book-segmenter.js';

const router = express.Router();

// Lazy-init Supabase Client (avoids running before dotenv.config())
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
    if (!_supabase) {
        _supabase = createClient(
            process.env.VITE_SUPABASE_URL || '',
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
        );
    }
    return _supabase;
}

// ------------------------------------------------------------------
// POST /api/ingest
// Body: { lessonId: string, files: Array<{ path: string, type: 'pdf' | 'audio' }> }
// ------------------------------------------------------------------
router.post('/ingest', async (req, res) => {
    try {
        const { lessonId, files } = req.body;

        if (!lessonId || !files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Missing lessonId or files array' });
        }

        console.log(`📥 Ingesting lesson ${lessonId} with ${files.length} files...`);

        const results = [];

        for (const file of files) {
            console.log(`Processing file: ${file.path} (${file.type})`);

            // Create a content hash (simple for now, ideally strictly from file content)
            const contentHash = `${lessonId}-${file.path}-${Date.now()}`;

            if (file.type === 'pdf' || file.type === 'document' || file.name?.endsWith('.pdf') || file.path?.endsWith('.pdf')) {
                console.log(`[Ingest] Starting PDF processing: ${file.path}`);
                const result = await processPdfJob(getSupabase(), lessonId, file.path, contentHash);
                console.log(`[Ingest] ✅ PDF done: ${result.chunksCreated} chunks, ${result.totalChars} chars, method: ${result.method}`);
                results.push({ file: file.path, status: 'processed', details: result });
            } else if (file.type === 'audio' || file.name?.match(/\.(mp3|wav|m4a|mp4|ogg)$/i) || file.path?.match(/\.(mp3|wav|m4a|mp4|ogg)$/i)) {
                // Audio processing (Whisper -> Chunk -> Embedding)
                const result = await processAudioJob(getSupabase(), lessonId, file.path, contentHash);
                results.push({ file: file.path, status: 'processed', details: result });
            } else if (file.type === 'image' || file.name?.match(/\.(jpg|jpeg|png|webp)$/i)) {
                // Image processing (GPT-4o Vision -> Chunk -> Embedding)
                const result = await processImageJob(getSupabase(), lessonId, file.path, contentHash);
                results.push({ file: file.path, status: 'processed', details: result });
            } else {
                console.warn(`Skipping unsupported file type: ${file.type} (${file.path})`);
                results.push({ file: file.path, status: 'skipped', reason: 'unsupported type' });
            }
        }

        // ─── Generate Embeddings for all new chunks ─────────────
        console.log(`[Ingest] 🔄 Generating embeddings for lesson ${lessonId}...`);
        try {
            const embedResult = await embedLessonSections(getSupabase(), lessonId);
            console.log(`[Ingest] ✅ Embeddings: ${embedResult.newlyEmbedded} new, ${embedResult.alreadyEmbedded} cached, ${embedResult.failedBatches} failed`);
        } catch (embedErr: any) {
            // Non-fatal: analysis can still work without embeddings (direct content fallback)
            console.warn(`[Ingest] ⚠️ Embeddings failed (non-fatal): ${embedErr.message}`);
        }

        res.json({ success: true, results });

    } catch (error: any) {
        console.error('❌ Ingest Error:', error);
        res.status(500).json({ error: error.message || 'Ingestion failed' });
    }
});

// ------------------------------------------------------------------
// POST /api/analyze
// Body: { lessonId: string }
// Query: ?stream=1 (optional — enables Server-Sent Events progress)
// ------------------------------------------------------------------
router.post('/analyze', async (req, res) => {
    try {
        const { lessonId } = req.body;

        if (!lessonId) {
            return res.status(400).json({ error: 'Missing lessonId' });
        }

        const requestUrl = new URL(req.originalUrl || req.url || '/api/analyze', 'http://localhost');
        const useSSE = requestUrl.searchParams.get('stream') === '1';
        console.log(`🧠 Analyzing lesson ${lessonId}${useSSE ? ' (SSE stream)' : ''}...`);

        if (useSSE) {
            // ─── SSE Mode: stream progress events ───────────────
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'  // Disable nginx buffering
            });

            const sendEvent = (data: any) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            try {
                const analysisResult = await generateLessonAnalysis(
                    getSupabase(),
                    lessonId,
                    (step, message, percent) => {
                        sendEvent({ type: 'progress', step, message, percent });
                    }
                );

                sendEvent({ type: 'done', data: analysisResult });
            } catch (error: any) {
                sendEvent({ type: 'error', error: error.message });
            }

            res.end();

        } else {
            // ─── Classic Mode (no streaming) ────────────────────
            const analysisResult = await generateLessonAnalysis(getSupabase(), lessonId);
            res.json({ success: true, data: analysisResult });
        }

    } catch (error: any) {
        console.error('❌ Analysis Error:', error);
        res.status(500).json({ error: error.message || 'Analysis failed' });
    }
});

// ------------------------------------------------------------------
// POST /api/segment-book
// Body: { subjectId: string, filePath: string, userId: string }
// Segments a full textbook PDF into individual lessons automatically.
// ------------------------------------------------------------------
router.post('/segment-book', async (req, res) => {
    try {
        const { subjectId, filePath, userId } = req.body;

        if (!subjectId || !filePath || !userId) {
            return res.status(400).json({
                error: 'Missing required fields: subjectId, filePath, userId'
            });
        }

        console.log(`📚 Segmenting book for subject ${subjectId}...`);
        console.log(`   File: ${filePath}`);

        const result = await segmentBook(getSupabase(), subjectId, userId, filePath, {
            autoAnalyze: false, // Don't analyze yet; wait for user to add audio!
            autoEmbed: true     // Keep embeddings for Focus Extraction (Similarity Score)
        });

        const succeeded = result.lessons.filter(l => l.status !== 'failed').length;
        const failed = result.lessons.filter(l => l.status === 'failed').length;

        res.json({
            success: true,
            message: `تم تقسيم الكتاب إلى ${result.lessonsDetected} درس (${succeeded} نجح، ${failed} فشل)`,
            data: result
        });

    } catch (error: any) {
        console.error('❌ Segment Book Error:', error);
        res.status(500).json({ error: error.message || 'Book segmentation failed' });
    }
});

// ------------------------------------------------------------------
// POST /api/reanalyze-lecture
// Body: { lessonId: string, lectureTitle: string }
// Resets a segmented_lecture and re-queues it for analysis.
// ------------------------------------------------------------------
router.post('/reanalyze-lecture', async (req, res) => {
    try {
        const { lessonId, lectureTitle } = req.body;
        if (!lessonId || !lectureTitle) {
            return res.status(400).json({ error: 'Missing lessonId or lectureTitle' });
        }

        const supabase = getSupabase();
        console.log(`🔄 Re-analyzing lecture "${lectureTitle}" in lesson ${lessonId}`);

        // Find the matching segmented_lecture
        const { data: segments } = await supabase.from('segmented_lectures')
            .select('id, title, start_page, end_page, summary_storage_path, status')
            .eq('lesson_id', lessonId).order('start_page', { ascending: true });

        const matchingSeg = segments?.find((s: any) =>
            s.title === lectureTitle ||
            s.title?.includes(lectureTitle?.split(':').pop()?.trim() || '___') ||
            lectureTitle?.includes(s.title)
        );

        if (!matchingSeg) {
            return res.status(404).json({ error: 'Lecture segment not found', searched: lectureTitle });
        }

        // Check for existing pending/processing jobs for this segment (prevent duplicates)
        const { data: existingJobs } = await supabase.from('processing_queue')
            .select('id, status')
            .eq('job_type', 'analyze_lecture')
            .in('status', ['pending', 'processing'])
            .like('dedupe_key', `%${matchingSeg.id}%`)
            .limit(1);

        if (existingJobs && existingJobs.length > 0) {
            console.log(`⚠️ Job already exists for "${matchingSeg.title}" (${existingJobs[0].status})`);
            return res.json({ success: true, segmentId: matchingSeg.id, title: matchingSeg.title, alreadyQueued: true });
        }

        // Reset the segment status
        await supabase.from('segmented_lectures')
            .update({ status: 'ocr_done', summary_storage_path: null, char_count: 0 })
            .eq('id', matchingSeg.id);

        // Insert a fresh analyze_lecture job
        const { error: insertError } = await supabase.from('processing_queue').insert({
            lesson_id: lessonId,
            job_type: 'analyze_lecture',
            payload: {
                lecture_id: matchingSeg.id,
                title: matchingSeg.title,
                start_page: matchingSeg.start_page,
                end_page: matchingSeg.end_page
            },
            status: 'pending',
            dedupe_key: `lesson:${lessonId}:reanalyze:${matchingSeg.id}:${Date.now()}`
        });

        if (insertError) {
            console.error('❌ Insert error:', insertError);
            return res.status(500).json({ error: insertError.message });
        }

        console.log(`✅ Re-analysis job created for "${matchingSeg.title}" (segment ${matchingSeg.id})`);

        // Trigger workers immediately from server-side to process the job
        const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        for (let i = 0; i < 3; i++) {
            fetch(`${supabaseUrl}/functions/v1/analyze-lesson`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: 'trigger' })
            }).catch(() => { });
        }

        res.json({ success: true, segmentId: matchingSeg.id, title: matchingSeg.title });

    } catch (error: any) {
        console.error('❌ Reanalyze Error:', error);
        res.status(500).json({ error: error.message || 'Reanalyze failed' });
    }
});

// ------------------------------------------------------------------
// POST /api/fetch-audio-transcript
// Body: { lessonId: string }
// Fetches audio transcript from storage, or re-transcribes if missing
// ------------------------------------------------------------------
router.post('/api/fetch-audio-transcript', async (req, res) => {
    try {
        const { lessonId } = req.body;
        if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });

        const supabase = getSupabase();
        const geminiKey = process.env.GEMINI_API_KEY;

        // 1. Try to load from storage
        const storagePath = `audio_transcripts/${lessonId}/raw_transcript.txt`;
        try {
            const { data: blob } = await supabase.storage.from('audio_transcripts').download(storagePath);
            if (blob) {
                const text = await blob.text();
                if (text.trim().length > 50) {
                    console.log(`🎧 [Audio] Found existing transcript (${text.length} chars)`);
                    return res.json({ success: true, transcript: text.trim(), source: 'storage' });
                }
            }
        } catch (_) { }

        // 2. Try document_sections fallback
        const { data: audioSections } = await supabase.from('document_sections')
            .select('content').eq('lesson_id', lessonId)
            .eq('source_type', 'audio').order('section_index', { ascending: true });
        if (audioSections && audioSections.length > 0) {
            const text = audioSections.map(s => s.content).join('\n\n');
            if (text.trim().length > 50) {
                console.log(`🎧 [Audio] Found transcript from document_sections (${text.length} chars)`);
                return res.json({ success: true, transcript: text.trim(), source: 'document_sections' });
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
            console.log(`🎧 [Audio] Transcript still processing for ${lessonId}`);
            return res.json({ success: false, status: 'processing', message: 'جاري التفريغ الصوتي، يرجى الانتظار...' });
        }

        console.log(`🎧 [Audio] No transcript found for ${lessonId} and no active jobs.`);
        return res.json({ success: false, status: 'missing', error: 'لم يتم العثور على تفريغ صوتي.' });

    } catch (error: any) {
        console.error('❌ Audio Transcript Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ------------------------------------------------------------------
// POST /api/reanalyze-direct
// Body: { lessonId: string, lectureId: string }
// DIRECT re-analysis: fetches OCR, calls Gemini, saves to storage.
// Bypasses Edge Function pipeline entirely for 100% reliability.
// ------------------------------------------------------------------
router.post('/reanalyze-direct', async (req, res) => {
    const startTime = Date.now();
    try {
        const { lessonId, lectureId } = req.body;
        if (!lessonId || !lectureId) {
            return res.status(400).json({ error: 'Missing lessonId or lectureId' });
        }

        const supabase = getSupabase();
        const geminiKey = process.env.GEMINI_API_KEY || '';
        if (!geminiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
        }

        console.log(`🔄 [Direct Reanalyze] Starting for lecture ${lectureId} in lesson ${lessonId}`);

        // 1. Get the segment info
        const { data: segment } = await supabase.from('segmented_lectures')
            .select('id, title, start_page, end_page, lesson_id')
            .eq('id', lectureId).single();

        if (!segment) {
            return res.status(404).json({ error: 'Segment not found' });
        }

        console.log(`📄 [Direct Reanalyze] Segment: "${segment.title}" pages ${segment.start_page}-${segment.end_page}`);

        // 2. Fetch ALL OCR text for this segment's page range
        const { data: pages } = await supabase.from('lesson_pages')
            .select('page_number, storage_path')
            .eq('lesson_id', lessonId)
            .gte('page_number', segment.start_page)
            .lte('page_number', segment.end_page)
            .order('page_number', { ascending: true });

        const alreadyReadPaths = new Set<string>();
        let rawTextChunks: string[] = [];

        for (const p of (pages || [])) {
            if (!p.storage_path || alreadyReadPaths.has(p.storage_path)) continue;
            alreadyReadPaths.add(p.storage_path);

            try {
                const { data: textData } = await supabase.storage.from('ocr').download(p.storage_path);
                if (textData) {
                    const rawText = await textData.text();
                    const cleaned = rawText.trim();
                    if (cleaned.length > 50) {
                        rawTextChunks.push(cleaned);
                    }
                }
            } catch (e) {
                console.warn(`[Direct Reanalyze] Failed to read OCR for ${p.storage_path}:`, e);
            }
        }

        const totalChars = rawTextChunks.join('').length;
        console.log(`📝 [Direct Reanalyze] Got ${rawTextChunks.length} text chunks, total ${totalChars} chars`);

        // FALLBACK: If OCR text is insufficient, re-read directly from the PDF via Gemini Vision
        if (totalChars < 500) {
            console.log(`⚠️ [Direct Reanalyze] OCR text insufficient (${totalChars} chars). Attempting PDF re-read fallback...`);

            try {
                // Step 1: Find gemini_file_uri from processing_queue payload
                let geminiUri = '';
                const { data: jobs } = await supabase.from('processing_queue')
                    .select('payload').eq('lesson_id', lessonId)
                    .eq('job_type', 'extract_pdf_info').limit(1);

                if (jobs?.[0]?.payload?.gemini_file_uri) {
                    geminiUri = jobs[0].payload.gemini_file_uri;
                    console.log(`📎 [Direct Reanalyze] Found gemini_file_uri from processing_queue: ${geminiUri.substring(0, 60)}...`);
                }

                // Step 2: If no URI or URI expired, re-upload PDF from homework-uploads
                if (!geminiUri) {
                    console.log(`🔍 [Direct Reanalyze] No cached URI. Looking for PDF in homework-uploads...`);
                    const { data: lesson } = await supabase.from('lessons')
                        .select('sources').eq('id', lessonId).single();

                    const pdfSource = (lesson?.sources || []).find((s: any) =>
                        s.type === 'pdf' || s.type === 'document' || (s.name || s.content || '').toLowerCase().endsWith('.pdf')
                    );

                    if (pdfSource) {
                        const pdfPath = pdfSource.content || pdfSource.uploadedUrl?.split('/homework-uploads/')[1] || '';
                        if (pdfPath) {
                            const cleanPath = decodeURIComponent(pdfPath.trim()).replace(/^\/+/, '').split('?')[0];
                            console.log(`📥 [Direct Reanalyze] Downloading PDF from homework-uploads/${cleanPath}...`);

                            const { data: pdfBlob, error: dlErr } = await supabase.storage.from('homework-uploads').download(cleanPath);
                            if (pdfBlob && !dlErr) {
                                // Upload fresh to Gemini File API
                                const arrayBuf = await pdfBlob.arrayBuffer();
                                const base64 = Buffer.from(arrayBuf).toString('base64');

                                console.log(`📤 [Direct Reanalyze] Uploading PDF to Gemini (${Math.round(arrayBuf.byteLength / 1024)}KB)...`);

                                const uploadResp = await fetch(
                                    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiKey}`,
                                    {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/pdf',
                                            'X-Goog-Upload-Protocol': 'raw',
                                        },
                                        body: Buffer.from(arrayBuf)
                                    }
                                );

                                if (uploadResp.ok) {
                                    const uploadData = await uploadResp.json();
                                    geminiUri = uploadData.file?.uri || '';
                                    console.log(`✅ [Direct Reanalyze] Fresh Gemini URI: ${geminiUri.substring(0, 60)}...`);
                                } else {
                                    console.warn(`⚠️ [Direct Reanalyze] Gemini upload failed: ${uploadResp.status}`);
                                }
                            } else {
                                console.warn(`⚠️ [Direct Reanalyze] PDF download failed:`, dlErr?.message);
                            }
                        }
                    }
                }

                // Step 3: Use the gemini_file_uri to OCR the specific pages
                if (geminiUri) {
                    const pdfPrompt = `أنت خبير في استخراج النصوص العربية من ملفات PDF. اقرأ الصفحات من ${segment.start_page} إلى ${segment.end_page} واستخرج النص كاملاً.
القواعد:
- استخرج كل النص بدقة
- حافظ على ترتيب الفقرات
- اكتب النص بالكامل كما هو مع الحفاظ على التشكيل والفقرات
- قم بتنظيف النص وإزالة أي تكرار غير طبيعي للحروف
- لا تضف أي تعليقات أو هوامش من عندك

مطلوب استخراج النص من الصفحات ${segment.start_page} إلى ${segment.end_page} فقط.`;

                    console.log(`🔄 [Direct Reanalyze] Re-OCR via Gemini Vision for pages ${segment.start_page}-${segment.end_page}...`);

                    const ocrResponse = await fetch(
                        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{
                                    parts: [
                                        { text: pdfPrompt },
                                        { fileData: { fileUri: geminiUri, mimeType: 'application/pdf' } }
                                    ]
                                }],
                                generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
                            })
                        }
                    );

                    const ocrData = await ocrResponse.json();
                    if (ocrResponse.ok) {
                        const extractedText = ocrData.candidates?.[0]?.content?.parts
                            ?.filter((p: any) => p.text).map((p: any) => p.text).join('').trim() || '';

                        if (extractedText.length > 100) {
                            console.log(`✅ [Direct Reanalyze] PDF re-read got ${extractedText.length} chars!`);
                            rawTextChunks = [extractedText];

                            // Save the re-OCR'd text for future use
                            const ocrStoragePath = `ocr/${lessonId}/reocr_${segment.start_page}_${segment.end_page}.txt`;
                            await supabase.storage.from('ocr')
                                .upload(ocrStoragePath, extractedText, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

                            for (let pn = segment.start_page; pn <= segment.end_page; pn++) {
                                await supabase.from('lesson_pages').update({
                                    storage_path: ocrStoragePath,
                                    char_count: extractedText.length,
                                    status: 'success'
                                }).eq('lesson_id', lessonId).eq('page_number', pn);
                            }
                        } else {
                            console.warn(`⚠️ [Direct Reanalyze] PDF re-read returned insufficient text (${extractedText.length} chars)`);
                        }
                    } else {
                        console.warn(`⚠️ [Direct Reanalyze] Gemini Vision call failed:`, ocrData.error?.message);
                    }
                } else {
                    console.warn(`⚠️ [Direct Reanalyze] Could not obtain any Gemini file URI`);
                }
            } catch (fallbackErr: any) {
                console.warn(`⚠️ [Direct Reanalyze] PDF fallback error:`, fallbackErr.message);
            }

            // If still no text after fallback, return error
            if (rawTextChunks.join('').length < 100) {
                return res.json({ success: true, status: 'no_text', title: segment.title, charCount: 0 });
            }
        }

        // 3. Combine all text and call Gemini directly
        const fullText = rawTextChunks.join('\n\n---\n\n');

        // Fetch audio transcript if available
        let audioSection = '';
        try {
            const audioPath = `audio_transcripts/${lessonId}/raw_transcript.txt`;
            const { data: audioBlob } = await supabase.storage.from('audio_transcripts').download(audioPath);
            if (audioBlob) {
                const audioText = await audioBlob.text();
                if (audioText.length > 50) {
                    audioSection = `\n--- 🎙️ تفريغ التسجيل الصوتي للمعلم ---\n${audioText}\n
                    عليك تحليل هذا التسجيل الصوتي بدقة. استخرج النقاط التي ركّز عليها المعلم في شرحه والتي ترتبط بمحتوى الكتاب.
                    ضع كل نقطة تركيز في مصفوفة \`focusPoints\` مع شرح مفصل لماذا هي مهمة وكيف فسّرها المعلم.`;
                }
            }
        } catch (_) { /* No audio is fine */ }

        const prompt = `[تعليمات النظام — ممنوع تجاوزها]
أنت أستاذ جامعي متخصص في تحليل الكتب الدراسية الجامعية العربية.
أنت الآن تحلل جزءاً من كتاب دراسي أكاديمي.

⛔ حدود صارمة مطلقة (انتهاكها = رفض فوري):
1. استخدم المحتوى المقدم لك فقط. لا تؤلف، لا تخترع، لا تضف أي معلومة غير موجودة حرفياً في النص.
2. إذا كان النص المقدم فارغاً أو غير مفهوم أو لا يحتوي على محتوى أكاديمي حقيقي، أرجع JSON فارغ هكذا بالضبط:
   {"explanation_notes": "", "key_definitions": [], "focusPoints": []}
3. ممنوع منعاً باتاً الحديث عن مواضيع غير موجودة في النص.
4. ممنوع كتابة "سؤال وهمي" أو أي عبارة تشير لعدم وجود محتوى.
5. إذا رأيت عبارات مثل "No extraction possible" أو "Error" أو رسائل نظام، تجاهلها تماماً.
6. لا تكرر نفس المحتوى أكثر من مرة.

ملاحظة: النصوص المسبوقة بـ 🎙️ تمثل نقاط ركّز عليها المعلم في تسجيله الصوتي.
${audioSection}

المطلوب: شرح تفصيلي وعميق جداً لهذا الجزء بصيغة Markdown.

📌 تنسيق المخرجات:
1. الطول: يجب ألا يقل الشرح (explanation_notes) عن 3000 حرف.

2. ⭐ قسم "أبرز ما ركّز عليه المعلم" — يظهر في أول الشرح:
   ابدأ الشرح بقسم خاص بالنقاط التي ذكرها المعلم في التسجيل الصوتي (إن وُجد تسجيل).
   استخدم التنسيق التالي:
   ## 🎙️ أبرز ما ركّز عليه المعلم
   > 🎙️ **نقطة مهمة:** شرح النقطة هنا بالتفصيل
   > 🎙️ **نقطة مهمة:** نقطة أخرى ذكرها المعلم

3. بعد ذلك، اشرح باقي المحتوى بالتفصيل مع عناوين وقوائم ونصوص غامقة.

4. أي نقطة ذكرها المعلم وتظهر لاحقاً في الشرح، ميّزها هكذا:
   > 🎙️ **ذكر المعلم:** النقطة المهمة هنا

المخرج: JSON فقط بالضبط هكذا:
{
  "explanation_notes": "الشرح التفصيلي يبدأ بقسم 🎙️ أبرز ما ركّز عليه المعلم...",
  "key_definitions": ["تعريف 1", "تعريف 2"],
  "focusPoints": [
     {"title": "🎙️ عنوان النقطة", "details": "شرح مفصل لما قاله المعلم وعلاقته بالكتاب"}
  ]
}

--- نص المحاضرة ---
${fullText}`;

        console.log(`🤖 [Direct Reanalyze] Calling Gemini with ${prompt.length} chars...`);

        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 65536, responseMimeType: 'application/json' }
                })
            }
        );

        const geminiData = await geminiResponse.json();
        if (!geminiResponse.ok) {
            throw new Error(`Gemini API error: ${geminiData.error?.message || geminiResponse.status}`);
        }

        const resultText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let parsed: any;
        try {
            // Try direct parse first
            parsed = JSON.parse(resultText);
        } catch {
            try {
                // Try extracting JSON from markdown code block
                const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[1].trim());
                } else {
                    // Try stripping control characters
                    const cleaned = resultText.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
                    parsed = JSON.parse(cleaned);
                }
            } catch {
                console.warn('[Direct Reanalyze] JSON parse failed, extracting explanation_notes via regex');
                // Last resort: extract explanation_notes directly
                const noteMatch = resultText.match(/"explanation_notes"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
                parsed = {
                    explanation_notes: noteMatch ? noteMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : resultText.substring(0, 5000),
                    key_definitions: [],
                    focusPoints: []
                };
            }
        }

        console.log(`✅ [Direct Reanalyze] Got ${(parsed.explanation_notes || '').length} chars of explanation`);

        // 4. Save to storage
        const finalJson = {
            title: segment.title,
            explanation_notes: parsed.explanation_notes || '',
            key_definitions: parsed.key_definitions || [],
            focusPoints: parsed.focusPoints || [],
            metadata: { generated_at: new Date().toISOString(), method: 'direct_reanalyze', elapsed_ms: Date.now() - startTime }
        };

        const storagePath = `${lessonId}/lecture_${lectureId}.json`;
        const { error: uploadErr } = await supabase.storage.from('analysis')
            .upload(storagePath, JSON.stringify(finalJson, null, 2), { upsert: true, contentType: 'application/json' });

        if (uploadErr) {
            throw new Error(`Storage upload failed: ${uploadErr.message}`);
        }

        // 5. Update segmented_lectures
        await supabase.from('segmented_lectures')
            .update({
                summary_storage_path: storagePath,
                char_count: (parsed.explanation_notes || '').length,
                status: 'quiz_done'
            })
            .eq('id', lectureId);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`🎉 [Direct Reanalyze] Done! "${segment.title}" — ${(parsed.explanation_notes || '').length} chars in ${elapsed}s`);

        res.json({
            success: true,
            title: segment.title,
            charCount: (parsed.explanation_notes || '').length,
            storagePath,
            elapsed: `${elapsed}s`,
            content: {
                explanation_notes: parsed.explanation_notes || '',
                key_definitions: parsed.key_definitions || [],
                focusPoints: parsed.focusPoints || []
            }
        });

    } catch (error: any) {
        console.error('❌ [Direct Reanalyze] Error:', error);
        res.status(500).json({ error: error.message || 'Direct reanalysis failed' });
    }
});

export default router;
