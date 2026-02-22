import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText, linkChunks } from './chunker';

/**
 * Audio Transcription + Chunking + Storage
 * 
 * Strategy: Gemini PRIMARY (handles up to 9.5 hours)
 *   - Files ≤ 15MB: inline data (fast)
 *   - Files > 15MB: File API upload first (no size limit truncation)
 *   Whisper as FALLBACK for short files only.
 */

const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MAX_BYTES = 20 * 1024 * 1024;
const GEMINI_INLINE_MAX = 15 * 1024 * 1024; // 15MB inline limit
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function getMime(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || 'mp3';
    const map: Record<string, string> = {
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'mp4': 'audio/mp4',
        'm4a': 'audio/mp4', 'ogg': 'audio/ogg', 'webm': 'audio/webm'
    };
    return map[ext] || 'audio/mpeg';
}

const TRANSCRIPTION_PROMPT = `أنت مفرّغ صوتي محترف ودقيق جداً متخصص في المحتوى الأكاديمي العربي.
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

// ─── Gemini File API (for files > 15MB) ─────────────────

async function uploadToGeminiFiles(buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY!;
    const fileSizeMB = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[Audio] 📤 Uploading ${fileSizeMB}MB to Gemini File API...`);

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

    if (!startRes.ok) throw new Error(`File API start: ${startRes.status} ${await startRes.text()}`);
    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL returned');

    // Step 2: Upload the file data
    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',  // Changed from POST to PUT for resumable upload
        headers: {
            'Content-Length': buffer.byteLength.toString(),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: buffer
    });

    if (!uploadRes.ok) throw new Error(`File API upload: ${uploadRes.status} ${await uploadRes.text()}`);
    const fileInfo = await uploadRes.json();
    const fileUri = fileInfo.file?.uri;
    if (!fileUri) throw new Error(`No file URI: ${JSON.stringify(fileInfo)}`);

    console.log(`[Audio] ✅ Uploaded: ${fileUri}`);

    // Step 3: Wait for file to be processed (ACTIVE state)
    const fileName2 = fileInfo.file?.name;
    for (let i = 0; i < 30; i++) {
        const statusRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${apiKey}`
        );
        const status = await statusRes.json();
        if (status.state === 'ACTIVE') {
            console.log(`[Audio] ✅ File ready for processing`);
            return fileUri;
        }
        if (status.state === 'FAILED') throw new Error('File processing failed');
        console.log(`[Audio] ⏳ File state: ${status.state}, waiting...`);
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('File processing timeout');
}

// ─── Gemini Transcription ───────────────────────────────

async function transcribeWithGemini(audioBuffer: ArrayBuffer, fileName: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const mimeType = getMime(fileName);
    const fileSizeMB = (audioBuffer.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[Audio] 🔄 Gemini transcription (${fileSizeMB} MB)...`);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    let audioPart: any;

    if (audioBuffer.byteLength > GEMINI_INLINE_MAX) {
        // Large file: use File API
        const fileUri = await uploadToGeminiFiles(audioBuffer, fileName, mimeType);
        audioPart = { fileData: { fileUri, mimeType } };
    } else {
        // Small file: inline base64
        const base64Audio = Buffer.from(audioBuffer).toString('base64');
        audioPart = { inlineData: { data: base64Audio, mimeType } };
    }

    // Try up to 2 attempts with different prompts
    const prompts = [
        TRANSCRIPTION_PROMPT,
        'استمع للتسجيل الصوتي التالي بعناية وحوّله إلى نص عربي مكتوب. اكتب كل ما يقوله المتحدث بالضبط. اكتب النص فقط.'
    ];

    for (let attempt = 0; attempt < prompts.length; attempt++) {
        console.log(`[Audio] Gemini attempt ${attempt + 1}/${prompts.length}...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompts[attempt] }, audioPart] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.warn(`[Audio] Gemini API error: ${data.error?.message || response.status}`);
            if (attempt < prompts.length - 1) continue;
            throw new Error(`Gemini: ${data.error?.message || response.status}`);
        }

        // Check finishReason for issues
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
            console.warn(`[Audio] Gemini blocked (${finishReason})`);
            if (attempt < prompts.length - 1) continue;
            throw new Error(`Gemini blocked: ${finishReason}`);
        }

        // Extract text from ALL parts (Gemini 2.5 may split text + thinking)
        const parts = data.candidates?.[0]?.content?.parts || [];
        const text = parts
            .filter((p: any) => p.text)
            .map((p: any) => p.text)
            .join('')
            .trim();

        if (text.length >= 50) {
            console.log(`[Audio] ✅ Gemini transcription: ${text.length} chars (attempt ${attempt + 1})`);
            return text;
        }

        // Log debug info on empty response
        console.warn(`[Audio] Gemini attempt ${attempt + 1}: ${text.length} chars, finishReason: ${finishReason}, parts: ${parts.length}`);
        if (parts.length > 0) {
            console.warn(`[Audio] Parts types: ${parts.map((p: any) => Object.keys(p).join('+')).join(', ')}`);
        }

        // Wait before retry
        if (attempt < prompts.length - 1) {
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    throw new Error(`Gemini returned too short after ${prompts.length} attempts`);
}

// ─── Whisper Transcription (FALLBACK) ───────────────────

async function transcribeWithWhisper(audioBuffer: ArrayBuffer, fileName: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const blob = new Blob([audioBuffer], { type: getMime(fileName) });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-1');
    formData.append('language', 'ar');
    formData.append('response_format', 'text');

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(WHISPER_API_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: formData
            });

            if (response.status === 429 || response.status >= 500) {
                const errorText = await response.clone().text();
                if (errorText.includes('billing_not_active')) throw new Error(`Whisper Billing: ${errorText}`);
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
                    continue;
                }
            }

            if (!response.ok) throw new Error(`Whisper (${response.status}): ${await response.text()}`);

            const transcript = (await response.text()).trim();
            if (transcript.length < 50 || transcript.startsWith('{') || transcript.startsWith('<')) {
                throw new Error(`Whisper invalid (${transcript.length} chars)`);
            }

            console.log(`[Audio] ✅ Whisper: ${transcript.length} chars`);
            return transcript;
        } catch (err: any) {
            lastError = err;
            if (err.message?.includes('billing_not_active')) throw err;
        }
    }
    throw lastError || new Error('Whisper failed');
}

// ─── Main Pipeline ──────────────────────────────────────

export async function processAudioJob(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string,
    filePath: string,
    contentHash: string
): Promise<{ chunksCreated: number; transcriptionLength: number }> {

    // 1. Check cache
    const { data: cached } = await supabase
        .from('file_hashes').select('transcription')
        .eq('content_hash', contentHash).maybeSingle();

    let transcription: string;

    if (cached?.transcription && cached.transcription.length > 100) {
        transcription = cached.transcription;
        console.log(`[Audio] Using cached (${transcription.length} chars)`);
    } else {
        // 2. Download
        const { data: fileData, error: downloadError } = await supabase.storage
            .from('homework-uploads').download(filePath);
        if (downloadError || !fileData) throw new Error(`Download: ${downloadError?.message}`);

        const buffer = await fileData.arrayBuffer();
        const fileName = filePath.split('/').pop() || 'audio.mp3';
        const fileSizeMB = buffer.byteLength / (1024 * 1024);

        console.log(`[Audio] File: ${fileName} (${fileSizeMB.toFixed(1)} MB)`);

        // 3. Transcribe: Gemini FIRST, Whisper fallback
        try {
            transcription = await transcribeWithGemini(buffer, fileName);
        } catch (geminiErr: any) {
            console.warn(`[Audio] ⚠️ Gemini failed: ${geminiErr.message}. Trying Whisper...`);
            if (buffer.byteLength > WHISPER_MAX_BYTES) {
                throw new Error(`Audio ${fileSizeMB.toFixed(0)}MB: Gemini failed (${geminiErr.message}), too large for Whisper`);
            }
            transcription = await transcribeWithWhisper(buffer, fileName);
        }

        if (!transcription || transcription.trim().length < 5) {
            throw new Error('لم يتم التعرف على محتوى صوتي');
        }

        console.log(`[Audio] Final: ${transcription.length} chars`);

        // 4. Cache
        try {
            await supabase.from('file_hashes')
                .upsert({ content_hash: contentHash, lesson_id: lessonId, source_type: 'audio', file_path: filePath, transcription },
                    { onConflict: 'content_hash' });
        } catch (e) { console.warn('[Audio] Cache failed (non-fatal)'); }
    }

    // 5. Chunk
    const chunks = chunkText(transcription);
    if (chunks.length === 0) throw new Error('No chunks');

    // 6. Save
    await supabase.from('document_sections').delete()
        .eq('lesson_id', lessonId).eq('source_type', 'audio');

    const sectionsToInsert = chunks.map(chunk => ({
        lesson_id: lessonId,
        content: chunk.content,
        source_type: 'audio' as const,
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
        .from('document_sections').insert(sectionsToInsert).select('id');
    if (insertError) throw new Error(`Insert: ${insertError.message}`);

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

    return { chunksCreated: inserted?.length || 0, transcriptionLength: transcription.length };
}
