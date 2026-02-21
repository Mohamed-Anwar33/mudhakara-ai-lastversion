import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText, linkChunks, TextChunk } from './chunker';

/**
 * PDF Text Extraction + Chunking + Storage
 * 
 * Strategy: Gemini Vision ALWAYS PRIMARY for Arabic PDFs.
 * pdf-parse only as last resort (returns garbled Arabic).
 * Retry Gemini once if output is suspiciously short.
 */

// ─── Gemini Vision (PRIMARY — clean Arabic) ─────────────

async function extractWithGemini(buffer: Buffer, pageCount: number, attempt: number = 1): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const base64 = buffer.toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    console.log(`[PDF] 🔄 Gemini Vision extraction (${pageCount} pages, attempt ${attempt})...`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    {
                        text: `استخرج كل النص الموجود في هذا الملف PDF بدقة عالية وبالكامل.

هذا ملف ضخم (${pageCount} صفحة). يجب أن تستخرج كل النص من كل صفحة بدون استثناء.

القواعد:
- اكتب النص العربي كما هو بالضبط بدون تعديل
- حافظ على ترتيب الفقرات والعناوين والأقسام
- حافظ على الترقيم والتنسيق والأرقام
- استخرج من كل الصفحات (الصفحة 1 إلى ${pageCount})
- لا تضف أي تعليقات أو شروحات من عندك
- لا تختصر — اكتب كل كلمة موجودة في الملف
- أخرج النص المستخرج فقط`
                    },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[PDF] Gemini Vision attempt ${attempt}: ${text.length} chars`);

    // If output is suspiciously short for a big PDF, retry once
    const expectedMinChars = pageCount * 100; // ~100 chars per page minimum
    if (text.length < expectedMinChars && attempt === 1) {
        console.log(`[PDF] ⚠️ Output too short (${text.length} < expected ${expectedMinChars}). Retrying...`);
        await new Promise(r => setTimeout(r, 2000)); // Wait 2s
        return extractWithGemini(buffer, pageCount, 2);
    }

    return text;
}

// ─── pdf-parse (FALLBACK — all pages but garbled Arabic) ─

async function extractWithPdfParse(buffer: Buffer): Promise<{ text: string; pages: number }> {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const textResult = await parser.getText();
    await parser.destroy();

    let text = textResult.text.normalize('NFKC');
    text = text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { text, pages: textResult.pages.length };
}

// ─── Main Pipeline ──────────────────────────────────────

export async function processPdfJob(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string,
    filePath: string,
    contentHash: string
): Promise<{ chunksCreated: number; totalChars: number; method: string }> {

    const { data: fileData, error: downloadError } = await supabase.storage
        .from('homework-uploads').download(filePath);
    if (downloadError || !fileData) throw new Error(`Download failed: ${downloadError?.message}`);

    const buffer = Buffer.from(await fileData.arrayBuffer());
    console.log(`[PDF] Downloaded: ${(buffer.byteLength / 1024).toFixed(1)} KB`);

    // Get page count from pdf-parse (fast, always works)
    let pdfParseText = '';
    let pageCount = 0;

    try {
        const result = await extractWithPdfParse(buffer);
        pdfParseText = result.text;
        pageCount = result.pages;
        console.log(`[PDF] pdf-parse: ${pageCount} pages, ${pdfParseText.length} chars`);
    } catch (e: any) {
        console.warn(`[PDF] pdf-parse failed: ${e.message}`);
    }

    // Always try Gemini Vision first (best Arabic quality)
    let finalText = '';
    let method = 'none';

    try {
        const geminiText = await extractWithGemini(buffer, pageCount || 1);

        if (geminiText.length >= 200) {
            finalText = geminiText;
            method = 'gemini-vision';
            console.log(`[PDF] ✅ Using Gemini Vision: ${finalText.length} chars`);
        } else {
            console.warn(`[PDF] Gemini returned too little: ${geminiText.length} chars`);
        }
    } catch (e: any) {
        console.warn(`[PDF] Gemini Vision failed: ${e.message}`);
    }

    // Fallback to pdf-parse only if Gemini completely failed
    if (!finalText && pdfParseText.length >= 200) {
        finalText = pdfParseText;
        method = 'pdf-parse';
        console.log(`[PDF] ⚠️ Falling back to pdf-parse: ${finalText.length} chars (may be garbled)`);
    }

    if (!finalText) throw new Error('PDF extraction failed: no usable text');

    console.log(`[PDF] Final: ${finalText.length} chars via ${method}`);
    console.log(`[PDF] Preview: "${finalText.substring(0, 200).replace(/\n/g, ' ')}..."`);

    // ─── Chunk + Store ──────────────────────────────────
    const chunks: TextChunk[] = chunkText(finalText);
    console.log(`[PDF] Chunked: ${chunks.length} chunks`);
    if (chunks.length === 0) throw new Error('No chunks created');

    await supabase.from('document_sections').delete()
        .eq('lesson_id', lessonId).eq('source_type', 'pdf');

    const sectionsToInsert = chunks.map(chunk => ({
        lesson_id: lessonId,
        content: chunk.content,
        source_type: 'pdf' as const,
        source_file_id: filePath,
        chunk_index: chunk.chunkIndex,
        metadata: {
            content_hash: contentHash,
            start_char: chunk.metadata.startChar,
            end_char: chunk.metadata.endChar,
            token_estimate: chunk.metadata.tokenEstimate,
            extraction_method: method
        }
    }));

    const { data: inserted, error: insertError } = await supabase
        .from('document_sections').insert(sectionsToInsert).select('id');
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

    if (inserted && inserted.length > 1) {
        const links = linkChunks(inserted.map(r => r.id));
        for (const link of links) {
            if (link.prevId || link.nextId) {
                await supabase.from('document_sections')
                    .update({ prev_id: link.prevId, next_id: link.nextId })
                    .eq('id', link.id);
            }
        }
    }

    console.log(`[PDF] ✅ Done: ${inserted?.length || 0} chunks saved`);
    return { chunksCreated: inserted?.length || 0, totalChars: finalText.length, method };
}
