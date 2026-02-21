
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText, linkChunks, TextChunk } from './chunker';

/**
 * Image Processing Module (Board Notes / Handwriting)
 * 
 * Uses GPT-4o Vision to "read" the image and extract text/context.
 * Better than standard OCR for handwriting and diagrams.
 */

const GPT4O_URL = 'https://api.openai.com/v1/chat/completions';
const GPT4O_MODEL = 'gpt-4o';

/**
 * Extract text from image using GPT-4o Vision
 */
async function extractTextFromImage(base64Image: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY must be set');

    const response = await fetch(GPT4O_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: GPT4O_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Transcribe ONLY the text fro this whiteboard/note image. If there are diagrams, briefly describe them. Output Arabic text as-is." },
                        {
                            type: "image_url",
                            image_url: {
                                "url": `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000
        })
    });

    if (!response.ok) {
        throw new Error(`GPT-4o Vision error: ${response.statusText}`);
    }

    const result = await response.json();
    return result.choices[0]?.message?.content || '';
}

/**
 * Pipeline: Download Image > Extract Text (Vision) > Chunk > Save
 */
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

    // 2. Extract Text (Vision)
    const extractedText = await extractTextFromImage(base64);

    if (!extractedText || extractedText.length < 10) {
        console.log('[ImageProcessor] No text found in image');
        return { chunksCreated: 0, totalChars: 0 };
    }

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
            end_char: chunk.metadata.endChar
        }
    }));

    const { data: inserted, error: insertError } = await supabase
        .from('document_sections')
        .insert(sectionsToInsert)
        .select('id');

    if (insertError) throw new Error(`Failed to insert image sections: ${insertError.message}`);

    return {
        chunksCreated: inserted?.length || 0,
        totalChars: extractedText.length
    };
}
