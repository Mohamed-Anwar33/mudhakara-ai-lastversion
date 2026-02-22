import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { corsHeaders, jsonResponse, errorResponse, toBase64 } from '../_shared/utils.ts';
import { chunkText, linkChunks } from '../_shared/chunker.ts';

/**
 * Edge Function: ingest-file
 * 
 * Processes uploaded files (PDF, Audio, Image):
 * 1. Downloads from Supabase Storage
 * 2. Extracts text (Gemini Vision for PDF/Image, Gemini Audio for transcription)
 * 3. Chunks text and stores in document_sections
 * 4. Generates embeddings via OpenAI
 * 
 * Timeout: 150s (Supabase free tier)
 */

// ─── Constants ──────────────────────────────────────────

const GEMINI_INLINE_MAX = 15 * 1024 * 1024; // 15MB
const WHISPER_MAX_BYTES = 20 * 1024 * 1024;

const AUDIO_PROMPT = `أنت مفرّغ صوتي محترف ودقيق جداً. حوّل كل الكلام في هذا التسجيل الصوتي إلى نص عربي مكتوب.
⚠️ قواعد:
- فرّغ التسجيل كاملاً من أوله لآخره بدون توقف
- اكتب كل كلمة بدون حذف أو اختصار
- حافظ على الترتيب الزمني
- اكتب النص فقط بدون مقدمات أو تعليقات`;

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

// ─── Helper Functions ───────────────────────────────────

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

function getFileType(fileName: string, declaredType: string): 'pdf' | 'audio' | 'image' | 'text' {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (declaredType === 'text' || ext === 'txt') return 'text';
    if (ext === 'pdf' || declaredType === 'application/pdf') return 'pdf';
    if (declaredType === 'audio' || ['mp3', 'wav', 'mp4', 'm4a', 'ogg', 'webm'].includes(ext)) return 'audio';
    if (declaredType === 'image' || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
    return 'pdf'; // default
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

    // Read ALL text parts (Gemini 2.5 Flash may have thinking tokens in separate parts)
    const resParts = data.candidates?.[0]?.content?.parts || [];
    return resParts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
}

async function uploadToGeminiFiles(buffer: ArrayBuffer, fileName: string, mimeType: string, apiKey: string): Promise<string> {
    // Step 1: Start resumable upload
    const startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
        {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': buffer.byteLength.toString(),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ file: { displayName: fileName } })
        }
    );
    if (!startRes.ok) throw new Error(`File API start: ${startRes.status}`);
    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL');

    // Step 2: Upload file
    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': buffer.byteLength.toString(),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: buffer
    });
    if (!uploadRes.ok) throw new Error(`File API upload: ${uploadRes.status}`);
    const fileInfo = await uploadRes.json();
    const fileUri = fileInfo.file?.uri;
    if (!fileUri) throw new Error('No file URI');

    // Step 3: Wait for ACTIVE
    const fileName2 = fileInfo.file?.name;
    for (let i = 0; i < 30; i++) {
        const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${apiKey}`);
        const status = await s.json();
        if (status.state === 'ACTIVE') return fileUri;
        if (status.state === 'FAILED') throw new Error('File processing failed');
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('File processing timeout');
}

// ─── PDF Processing ─────────────────────────────────────

async function processPdf(supabase: any, lessonId: string, filePath: string, contentHash: string, geminiKey: string, file: any = {}) {
    let buffer;
    if (file.base64Chunk) {
        console.log(`[PDF] Received base64 chunk from client.`);
        const base64Data = file.base64Chunk.split(',')[1] || file.base64Chunk;
        buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0)).buffer;
    } else {
        const { data: fileData, error } = await supabase.storage.from('homework-uploads').download(filePath);
        if (error || !fileData) throw new Error(`Download: ${error?.message}`);
        buffer = await fileData.arrayBuffer();
        console.log(`[PDF] Downloaded: ${(buffer.byteLength / (1024 * 1024)).toFixed(2)} MB`);
    }

    const fileName = filePath.split('/').pop() || 'document.pdf';

    let pdfPart: any;
    // Use Files API for PDFs larger than 10MB to save memory
    if (buffer.byteLength > 10 * 1024 * 1024) {
        console.log(`[PDF] Large file detected, using Gemini Files API...`);
        const fileUri = await uploadToGeminiFiles(buffer, fileName, 'application/pdf', geminiKey);
        buffer = null as any; // Free memory early
        pdfPart = { fileData: { fileUri, mimeType: 'application/pdf' } };
    } else {
        const base64 = toBase64(buffer);
        buffer = null as any; // Free memory early
        pdfPart = { inlineData: { data: base64, mimeType: 'application/pdf' } };
    }

    const text = await callGemini(geminiKey, [
        { text: PDF_PROMPT },
        pdfPart
    ]);

    if (!text || text.length < 50) throw new Error(`PDF: Gemini returned ${text.length} chars`);
    console.log(`[PDF] Extracted: ${text.length} chars`);

    // If this is a chunk (has base64Chunk), append to existing sections instead of deleting them.
    // Differentiate by adjusting the sourceType or just the saveChunks logic.
    return await saveChunks(supabase, lessonId, text, 'pdf', file.path || filePath, contentHash, !!file.base64Chunk);
}

// ─── Audio Processing ───────────────────────────────────

async function processAudio(supabase: any, lessonId: string, filePath: string, contentHash: string, geminiKey: string) {
    // Check cache
    const { data: cached } = await supabase.from('file_hashes').select('transcription')
        .eq('content_hash', contentHash).maybeSingle();

    if (cached?.transcription && cached.transcription.length > 100) {
        console.log(`[Audio] Using cached (${cached.transcription.length} chars)`);
        return await saveChunks(supabase, lessonId, cached.transcription, 'audio', filePath, contentHash);
    }

    const { data: fileData, error } = await supabase.storage.from('homework-uploads').download(filePath);
    if (error || !fileData) throw new Error(`Download: ${error?.message}`);

    let buffer = await fileData.arrayBuffer();
    const fileName = filePath.split('/').pop() || 'audio.mp3';
    const mimeType = getMime(fileName);
    console.log(`[Audio] File: ${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MB`);

    // ✅ ALWAYS use Files API for audio to avoid base64 memory doubling
    // This sends the raw buffer directly to Gemini without base64 encoding
    const fileUri = await uploadToGeminiFiles(buffer, fileName, mimeType, geminiKey);
    // Free the buffer immediately after upload to reduce memory pressure
    buffer = null as any;

    const audioPart = { fileData: { fileUri, mimeType } };

    // Try Gemini with retry
    let text = '';
    const prompts = [AUDIO_PROMPT, 'استمع للتسجيل الصوتي التالي بعناية وحوّله إلى نص عربي مكتوب. اكتب كل ما يقوله المتحدث بالضبط. اكتب النص فقط.'];

    for (const prompt of prompts) {
        try {
            text = await callGemini(geminiKey, [{ text: prompt }, audioPart]);
            if (text.length >= 50) break;
        } catch (e: any) {
            console.warn(`[Audio] Gemini attempt failed: ${e.message}`);
        }
    }

    if (text.length < 50) throw new Error(`Audio: Gemini returned ${text.length} chars`);
    console.log(`[Audio] Transcription: ${text.length} chars`);

    // Cache
    await supabase.from('file_hashes').update({ transcription: text }).eq('content_hash', contentHash);

    return await saveChunks(supabase, lessonId, text, 'audio', filePath, contentHash);
}

// ─── Image Processing ───────────────────────────────────

async function processImage(supabase: any, lessonId: string, filePath: string, contentHash: string, geminiKey: string) {
    const { data: fileData, error } = await supabase.storage.from('homework-uploads').download(filePath);
    if (error || !fileData) throw new Error(`Download: ${error?.message}`);

    let buffer = await fileData.arrayBuffer();
    const fileName = filePath.split('/').pop() || 'image.jpg';
    const mimeType = getMime(fileName);
    console.log(`[Image] Downloaded: ${(buffer.byteLength / (1024 * 1024)).toFixed(2)} MB`);

    let imagePart: any;
    // Use Files API for images larger than 10MB to save memory
    if (buffer.byteLength > 10 * 1024 * 1024) {
        console.log(`[Image] Large file detected, using Gemini Files API...`);
        const fileUri = await uploadToGeminiFiles(buffer, fileName, mimeType, geminiKey);
        buffer = null as any; // Free memory early
        imagePart = { fileData: { fileUri, mimeType } };
    } else {
        const base64 = toBase64(buffer);
        buffer = null as any; // Free memory early
        imagePart = { inlineData: { data: base64, mimeType } };
    }

    const text = await callGemini(geminiKey, [
        { text: IMAGE_PROMPT },
        imagePart
    ]);

    if (!text || text.length < 10) {
        console.log('[Image] No text found');
        return { chunksCreated: 0, totalChars: 0 };
    }
    console.log(`[Image] Extracted: ${text.length} chars`);

    return await saveChunks(supabase, lessonId, text, 'image', filePath, contentHash);
}

// ─── Save Chunks ────────────────────────────────────────

async function saveChunks(supabase: any, lessonId: string, text: string, sourceType: string, filePath: string, contentHash: string, isAppend: boolean = false) {
    const chunks = chunkText(text);

    let startIndex = 0;

    // Only delete old sections if we are NOT appending a chunk
    if (!isAppend) {
        await supabase.from('document_sections').delete()
            .eq('lesson_id', lessonId).eq('source_type', sourceType);
    } else {
        // Find the highest chunk_index to append sequentially
        const { data: existing } = await supabase.from('document_sections')
            .select('chunk_index')
            .eq('lesson_id', lessonId)
            .eq('source_type', sourceType)
            .order('chunk_index', { ascending: false })
            .limit(1);

        if (existing && existing.length > 0) {
            startIndex = existing[0].chunk_index + 1;
        }
    }

    const sectionsToInsert = chunks.map(chunk => ({
        lesson_id: lessonId,
        content: chunk.content,
        source_type: sourceType,
        source_file_id: filePath,
        chunk_index: chunk.chunkIndex + startIndex,
        metadata: { content_hash: contentHash, start_char: chunk.metadata.startChar, end_char: chunk.metadata.endChar, token_estimate: chunk.metadata.tokenEstimate }
    }));

    const { data: inserted, error } = await supabase.from('document_sections')
        .insert(sectionsToInsert).select('id');
    if (error) throw new Error(`Insert: ${error.message}`);

    // Link chunks
    if (inserted && inserted.length > 1) {
        const links = linkChunks(inserted.map((r: any) => r.id));
        for (const link of links) {
            if (link.prevId || link.nextId) {
                await supabase.from('document_sections')
                    .update({ prev_id: link.prevId, next_id: link.nextId })
                    .eq('id', link.id);
            }
        }
    }

    return { chunksCreated: inserted?.length || 0, totalChars: text.length };
}

// ─── Generate Embeddings ────────────────────────────────

async function generateEmbeddings(supabase: any, lessonId: string, openaiKey: string) {
    const { data: sections } = await supabase.from('document_sections')
        .select('id, content')
        .eq('lesson_id', lessonId)
        .is('embedding', null)
        .limit(500);

    if (!sections || sections.length === 0) {
        console.log('[Embeddings] All sections already embedded');
        return { embedded: 0 };
    }

    console.log(`[Embeddings] ${sections.length} sections to embed`);
    const BATCH = 32;
    let totalEmbedded = 0;

    for (let i = 0; i < sections.length; i += BATCH) {
        const batch = sections.slice(i, i + BATCH);
        const texts = batch.map((s: any) => s.content);

        try {
            const res = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
            });

            if (!res.ok) {
                console.warn(`[Embeddings] Batch ${Math.floor(i / BATCH) + 1} failed: ${res.status}`);
                continue;
            }

            const data = await res.json();
            for (let j = 0; j < data.data.length; j++) {
                await supabase.from('document_sections')
                    .update({ embedding: JSON.stringify(data.data[j].embedding) })
                    .eq('id', batch[j].id);
            }
            totalEmbedded += batch.length;
            console.log(`[Embeddings] Batch ${Math.floor(i / BATCH) + 1}: ${batch.length} done`);
        } catch (e: any) {
            console.warn(`[Embeddings] Batch error: ${e.message}`);
        }
    }

    return { embedded: totalEmbedded };
}

// ─── Main Handler ───────────────────────────────────────

serve(async (req) => {
    // ✅ ALWAYS handle OPTIONS first for CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: {
                ...corsHeaders,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Max-Age': '86400',
            }
        });
    }

    // ✅ Wrap EVERYTHING in try-catch to ensure CORS headers are always returned
    try {
        if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

        const body = await req.json();
        const { lessonId, files } = body;

        if (!lessonId || !files || !Array.isArray(files)) {
            return errorResponse('Missing lessonId or files array', 400);
        }

        const supabaseUrl = Deno.env.get('APP_SUPABASE_URL') || Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('APP_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
        const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';

        console.log(`[Ingest] Config check - URL: ${supabaseUrl ? '✅' : '❌'}, Key: ${supabaseKey ? '✅' : '❌'}, Gemini: ${geminiKey ? '✅' : '❌'}`);

        if (!supabaseUrl || !supabaseKey) return errorResponse('Missing Supabase config', 500);
        if (!geminiKey) return errorResponse('Missing GEMINI_API_KEY', 500);

        const supabase = createClient(supabaseUrl, supabaseKey);
        const results = [];

        for (const file of files) {
            const contentHash = `${lessonId}-${file.path}-${Date.now()}`;
            const fileType = getFileType(file.name || file.path, file.type);
            console.log(`[Ingest] Processing: ${file.path} (${fileType})`);

            try {
                let result;
                if (file.extractedText) {
                    console.log(`[Ingest] Received raw text for ${file.path} (${file.extractedText.length} chars). Skipping Gemini.`);
                    result = await saveChunks(supabase, lessonId, file.extractedText, fileType, file.path, contentHash);
                } else if (fileType === 'pdf') {
                    // Update processPdf signature to accept the `file` object to pass base64Chunk
                    result = await processPdf(supabase, lessonId, file.path, contentHash, geminiKey, file);
                } else if (fileType === 'audio') {
                    result = await processAudio(supabase, lessonId, file.path, contentHash, geminiKey);
                } else {
                    result = await processImage(supabase, lessonId, file.path, contentHash, geminiKey);
                }
                results.push({ file: file.path, status: 'processed', details: result });
            } catch (e: any) {
                console.error(`[Ingest] Error processing ${file.path}: ${e.message}`);
                results.push({ file: file.path, status: 'failed', error: e.message });
            }
        }

        // Generate embeddings
        if (openaiKey) {
            try {
                const embedResult = await generateEmbeddings(supabase, lessonId, openaiKey);
                console.log(`[Ingest] Embeddings: ${embedResult.embedded} new`);
            } catch (e: any) {
                console.warn(`[Ingest] Embeddings failed (non-fatal): ${e.message}`);
            }
        }

        return jsonResponse({ success: true, results });

    } catch (error: any) {
        console.error('Ingest Fatal Error:', error);
        // ✅ Always return CORS headers even on crash
        return new Response(
            JSON.stringify({ error: error.message || 'Ingestion failed', stack: error.stack }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    }
});
