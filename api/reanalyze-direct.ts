import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Vercel API Route: POST /api/reanalyze-direct
 * 
 * DIRECT re-analysis: fetches OCR, calls Gemini, saves to storage.
 * Bypasses Edge Function pipeline entirely for 100% reliability.
 * Body: { lessonId: string, lectureId: string }
 */

export const config = {
    maxDuration: 300
};

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error('Missing env vars');
    return createClient(url, serviceKey);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const startTime = Date.now();
    try {
        const { lessonId, lectureId } = req.body || {};
        if (!lessonId || !lectureId) {
            return res.status(400).json({ error: 'Missing lessonId or lectureId' });
        }

        const supabase = getSupabaseAdmin();
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
                    let textToAnalyze = audioText;

                    // Support for Audio Chunking (e.g. "محتوى التسجيل الصوتي (الجزء X)")
                    // segment.title e.g. "محتوى التسجيل الصوتي (الجزء 2)", start_page is used as the chunk index
                    if (segment.title.includes('محتوى التسجيل الصوتي')) {
                        const words = audioText.split(/\s+/);
                        // If it's a chunked segment, slice the words array
                        if (words.length > 2000 && segment.start_page > 0) {
                            const chunkIndex = segment.start_page; // 1-based chunk index
                            const chunkSize = 2000;
                            const startIndex = (chunkIndex - 1) * chunkSize;
                            const endIndex = startIndex + chunkSize;

                            // Prevent out-of-bounds just in case
                            if (startIndex < words.length) {
                                textToAnalyze = words.slice(startIndex, endIndex).join(' ');
                                console.log(`[Direct Reanalyze] Audio is chunked. Analyzing chunk ${chunkIndex} (words ${startIndex} to ${endIndex})`);
                            }
                        }
                    }

                    audioSection = `\n--- 🎙️ تفريغ التسجيل الصوتي للمعلم ---\n${textToAnalyze}\n
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

        return res.json({
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
        return res.status(500).json({ error: error.message || 'Direct reanalysis failed' });
    }
}
