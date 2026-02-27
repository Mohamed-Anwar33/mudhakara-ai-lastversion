import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PDF_PROMPT = `أنت خبير في استخراج النصوص العربية من ملفات PDF. اقرأ كل صفحة ضمن النطاق المحدد واستخرج النص كاملاً.
القواعد:
- استخرج كل النص بدقة
- حافظ على ترتيب الفقرات
- اكتب النص بالكامل كما هو مع الحفاظ على التشكيل والفقرات
- قم بتنظيف النص وإزالة أي تكرار غير طبيعي للحروف ناتج عن المسح الضوئي (مثلاً إذا وجدت "اللممححااضضررة" صححها لتصبح "المحاضرة")
- لا تضف أي تعليقات أو هوامش من عندك`;

// Utility: Delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

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
                        const waitTime = Math.pow(2, attempt) * 2000 + Math.random() * 1000;
                        console.warn(`[Gemini OCR] ${response.status} Error. Retrying in ${waitTime}ms...`);
                        await delay(waitTime);
                        continue;
                    }
                }
                throw new Error(`Gemini: ${data.error?.message || response.status}`);
            }

            const resParts = data.candidates?.[0]?.content?.parts || [];
            return resParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
        } catch (error: any) {
            if (attempt < maxAttempts - 1) {
                const waitTime = Math.pow(2, attempt) * 2000 + Math.random() * 1000;
                await delay(waitTime);
                continue;
            }
            throw error;
        }
    }
    throw new Error('callGemini failed after max retries');
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const { jobId } = await req.json();
        if (!jobId) throw new Error('Missing jobId');

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: job, error: jobError } = await supabase
            .from('processing_queue')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) throw new Error('Job not found');

        const { job_type, payload, lesson_id } = job;

        console.log(`[ocr-worker] Executing ${job_type} for lesson ${lesson_id}`);

        // 1. Initial Job: extract_pdf_info
        if (job_type === 'extract_pdf_info') {
            const geminiUri = payload.gemini_file_uri;
            if (!geminiUri) throw new Error('Missing gemini_file_uri');

            // Assume total pages passed in payload from Vercel/Client or default to 50 for safety bracket
            const totalPages = payload.total_pages || 50;

            // Generate individual OCR tasks (Batching 5 pages per job to avoid timeout)
            const batchSize = 5;
            const jobsToInsert = [];
            const lessonPagesToInsert = [];

            for (let i = 1; i <= totalPages; i += batchSize) {
                const startPage = i;
                const endPage = Math.min(i + batchSize - 1, totalPages);
                const pageRange = { start: startPage, end: endPage };

                jobsToInsert.push({
                    lesson_id: lesson_id,
                    job_type: 'ocr_page_batch',
                    payload: { ...payload, page_range: pageRange },
                    status: 'pending',
                    dedupe_key: `lesson:${lesson_id}:ocr_batch:${startPage}_${endPage}`
                });

                // Track each physical page for the barrier check
                for (let p = startPage; p <= endPage; p++) {
                    lessonPagesToInsert.push({
                        lesson_id: lesson_id,
                        page_number: p,
                        status: 'pending'
                    });
                }
            }

            // Also spawn the Segmentation barrier that waits for OCR to finish
            jobsToInsert.push({
                lesson_id: lesson_id,
                job_type: 'segment_lesson',
                payload: { ...payload },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:segment_lesson`
            });

            await supabase.from('lesson_pages').upsert(lessonPagesToInsert, { onConflict: 'lesson_id,page_number', ignoreDuplicates: true });
            await supabase.from('processing_queue').upsert(jobsToInsert, { onConflict: 'dedupe_key', ignoreDuplicates: true });

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            return new Response(JSON.stringify({ status: 'completed', stage: 'queued_ocr_batches' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }


        // 2. OCR Batch Job: ocr_page_batch
        if (job_type === 'ocr_page_batch') {
            const geminiUri = payload.gemini_file_uri;
            const { start, end } = payload.page_range;

            // Only OCR if the pages are still pending (Idempotency)
            const { data: pageStatus } = await supabase.from('lesson_pages')
                .select('page_number, status')
                .eq('lesson_id', lesson_id)
                .gte('page_number', start)
                .lte('page_number', end)
                .eq('status', 'success');

            if (pageStatus && pageStatus.length === (end - start + 1)) {
                console.log(`[ocr-worker] Batch ${start}-${end} already processed successfully. Skipping.`);
                await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'completed', skipped: true }), { headers: corsHeaders });
            }

            const prompt = `${PDF_PROMPT}\n\nمطلوب استخراج النص من الصفحات ${start} إلى ${end} فقط.`;
            const filePart = { fileData: { fileUri: geminiUri, mimeType: 'application/pdf' } };

            let resultText = '';
            try {
                resultText = await callGemini(geminiKey, [{ text: prompt }, filePart]);
            } catch (err: any) {
                await supabase.from('lesson_pages').update({ status: 'failed', retry_count: 1 })
                    .eq('lesson_id', lesson_id).gte('page_number', start).lte('page_number', end);
                throw err;
            }

            // Instead of putting huge text in DB, save to Storage
            const storagePath = `ocr/${lesson_id}/batch_${start}_${end}.txt`;
            const { error: storageErr } = await supabase.storage.from('ocr')
                .upload(storagePath, resultText, { upsert: true, contentType: 'text/plain;charset=UTF-8' });

            if (storageErr) throw new Error(`Storage upload failed: ${storageErr.message}`);

            // Embed the chunk (Simulated pgvector insert for now)
            await supabase.from('document_embeddings').insert({
                lesson_id: lesson_id,
                page_number: start, // Tag it to the starting page of the batch
                storage_path: storagePath,
                // embedding: would be generated visually calling OpenAI Ada 002 here 
            });

            // Mark pages as success
            await supabase.from('lesson_pages').update({
                status: 'success',
                storage_path: storagePath,
                char_count: resultText.length
            })
                .eq('lesson_id', lesson_id)
                .gte('page_number', start)
                .lte('page_number', end);

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            return new Response(JSON.stringify({ status: 'completed' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        throw new Error(`Unhandled job type in ocr-worker: ${job_type}`);

    } catch (error: any) {
        console.error('[ocr-worker] Error:', error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
