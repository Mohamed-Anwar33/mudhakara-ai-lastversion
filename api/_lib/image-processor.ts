
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText, linkChunks, TextChunk } from './chunker';

/**
 * Image Processing Module (Board Notes / Handwriting)
 * 
 * Strategy: Gemini Vision PRIMARY (best for Arabic),
 *           GPT-4o Vision as FALLBACK.
 * 
 * Changes from v1:
 *  - Added Gemini Vision as primary (was GPT-4o only)
 *  - Arabic prompt (was English)
 *  - max_tokens: 4096 → 65536 for Gemini (1000 was too low)
 *  - Added linkChunks (was missing)
 */

const IMAGE_PROMPT = `أنت خبير في قراءة صور السبورة والملاحظات المكتوبة بخط اليد. استخرج كل النص الموجود في هذه الصورة.

القواعد:
- اكتب النص العربي كما هو بالضبط بدون تعديل
- إذا كانت هناك رسومات أو مخططات، صفها بإيجاز
- حافظ على ترتيب النص والعناوين
- لا تضف أي تعليقات أو شروحات من عندك
- أخرج النص المستخرج فقط`;

// ─── Gemini Vision (PRIMARY) ────────────────────────────

async function extractWithGemini(base64Image: string, mimeType: string = 'image/jpeg'): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    console.log(`[Image] 🔄 Gemini Vision extraction...`);

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: IMAGE_PROMPT },
                        { inlineData: { data: base64Image, mimeType } }
                    ]
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
            })
        }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[Image] Gemini Vision: ${text.length} chars`);
    return text;
}

// ─── GPT-4o Vision (FALLBACK) ───────────────────────────

async function extractWithGPT4o(base64Image: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    console.log(`[Image] 🔄 GPT-4o Vision extraction (fallback)...`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: IMAGE_PROMPT },
                        {
                            type: "image_url",
                            image_url: {
                                "url": `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 4096
        })
    });

    if (!response.ok) {
        throw new Error(`GPT-4o Vision error: ${response.statusText}`);
    }

    const result = await response.json();
    const text = result.choices[0]?.message?.content || '';
    console.log(`[Image] GPT-4o Vision: ${text.length} chars`);
    return text;
}

// ─── Main Pipeline ──────────────────────────────────────

export async function processImageJob(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string,
    filePath: string,
    contentHash: string
): Promise<{ chunksCreated: number; totalChars: number }> {

    // 1. Download Image
    const { data: fileData, error: downloadError } = await supabase.storage
        .from('homework-uploads')
        .download(filePath);

    if (downloadError || !fileData) {
        throw new Error(`Failed to download image: ${downloadError?.message}`);
    }

    const buffer = await fileData.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Detect MIME type from file extension
    const ext = filePath.split('.').pop()?.toLowerCase() || 'jpeg';
    const mimeMap: Record<string, string> = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'png': 'image/png', 'webp': 'image/webp'
    };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    // 2. Extract Text — Gemini PRIMARY, GPT-4o FALLBACK
    let extractedText = '';

    try {
        extractedText = await extractWithGemini(base64, mimeType);
    } catch (geminiErr: any) {
        console.warn(`[Image] ⚠️ Gemini failed: ${geminiErr.message}. Trying GPT-4o...`);
        try {
            extractedText = await extractWithGPT4o(base64);
        } catch (gptErr: any) {
            console.error(`[Image] ❌ Both Gemini and GPT-4o failed`);
            throw new Error(`Image OCR failed: Gemini (${geminiErr.message}), GPT-4o (${gptErr.message})`);
        }
    }

    if (!extractedText || extractedText.length < 10) {
        console.log('[Image] No text found in image');
        return { chunksCreated: 0, totalChars: 0 };
    }

    console.log(`[Image] ✅ Extracted: ${extractedText.length} chars`);

    // 3. Chunk
    const chunks: TextChunk[] = chunkText(extractedText);

    // 4. Delete old sections
    await supabase.from('document_sections').delete()
        .eq('lesson_id', lessonId)
        .eq('source_type', 'image');

    // 5. Insert
    const sectionsToInsert = chunks.map(chunk => ({
        lesson_id: lessonId,
        content: chunk.content,
        source_type: 'image' as const,
        source_file_id: filePath,
        chunk_index: chunk.chunkIndex,
        metadata: {
            content_hash: contentHash,
            start_char: chunk.metadata.startChar,
            end_char: chunk.metadata.endChar,
            token_estimate: chunk.metadata.tokenEstimate
        }
    }));

    const { data: inserted, error: insertError } = await supabase
        .from('document_sections')
        .insert(sectionsToInsert)
        .select('id');

    if (insertError) throw new Error(`Failed to insert image sections: ${insertError.message}`);

    // 6. Link chunks (was missing in v1!)
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

    console.log(`[Image] ✅ Done: ${inserted?.length || 0} chunks saved`);
    return {
        chunksCreated: inserted?.length || 0,
        totalChars: extractedText.length
    };
}
