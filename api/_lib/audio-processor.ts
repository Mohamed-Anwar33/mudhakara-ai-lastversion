import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText, linkChunks } from './chunker.js';

/**
 * Audio Transcription + Chunking + Storage
 * 
 * Strategy: Whisper PRIMARY (most accurate for Arabic)
 *   - Files ≤ 25MB: Whisper first with aggressive retry on 429
 *   - Files > 25MB: Gemini File API (no size limit)
 *   Gemini as FALLBACK if Whisper fails for any reason.
 */

const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25MB Whisper limit
const GEMINI_INLINE_MAX = 15 * 1024 * 1024; // 15MB inline limit
const MAX_RETRIES = 5;       // More retries for rate limits
const BASE_DELAY_MS = 2000;  // Start with 2s delay
const MAX_DELAY_MS = 64000;  // Cap at 64s

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

// ─── Whisper Transcription (PRIMARY) ────────────────────

async function transcribeWithWhisper(audioBuffer: ArrayBuffer, fileName: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const mimeType = getMime(fileName);
    const fileSizeMB = (audioBuffer.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[Audio] 🎤 Whisper transcription (${fileSizeMB} MB)...`);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            // Must recreate FormData each attempt (consumed by fetch)
            const blob = new Blob([audioBuffer], { type: mimeType });
            const formData = new FormData();
            formData.append('file', blob, fileName);
            formData.append('model', 'whisper-1');
            formData.append('language', 'ar');
            formData.append('response_format', 'text');

            const response = await fetch(WHISPER_API_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: formData
            });

            // Handle rate limits (429) and server errors (5xx) with retry
            if (response.status === 429 || response.status >= 500) {
                const errorText = await response.clone().text();

                // Billing not active = permanent failure, no retry
                if (errorText.includes('billing_not_active')) {
                    throw new Error(`Whisper billing not active: ${errorText.substring(0, 200)}`);
                }

                if (attempt < MAX_RETRIES - 1) {
                    // Respect Retry-After header if present
                    const retryAfter = response.headers.get('Retry-After');
                    let delayMs: number;

                    if (retryAfter) {
                        // Retry-After can be seconds or a date
                        const retrySeconds = parseInt(retryAfter, 10);
                        delayMs = (isNaN(retrySeconds) ? 10 : retrySeconds) * 1000;
                    } else {
                        // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s (±25%)
                        delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
                        // Add jitter (±25%) to prevent thundering herd
                        delayMs = delayMs * (0.75 + Math.random() * 0.5);
                    }

                    console.warn(`[Audio] ⏳ Whisper ${response.status} — retry ${attempt + 1}/${MAX_RETRIES} after ${(delayMs / 1000).toFixed(1)}s`);
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                // All retries exhausted
                throw new Error(`Whisper rate limited (429) after ${MAX_RETRIES} retries. Last: ${errorText.substring(0, 200)}`);
            }

            if (!response.ok) throw new Error(`Whisper (${response.status}): ${await response.text()}`);

            const transcript = (await response.text()).trim();

            // Validate output
            if (transcript.length < 50 || transcript.startsWith('{') || transcript.startsWith('<')) {
                throw new Error(`Whisper returned invalid output (${transcript.length} chars)`);
            }

            console.log(`[Audio] ✅ Whisper: ${transcript.length} chars (attempt ${attempt + 1})`);
            return transcript;
        } catch (err: any) {
            lastError = err;
            // Permanent errors: don't retry
            if (err.message?.includes('billing_not_active')) throw err;
            if (err.message?.includes('invalid_api_key')) throw err;
            // Transient errors: continue retry loop
            if (attempt < MAX_RETRIES - 1) {
                console.warn(`[Audio] ⚠️ Whisper attempt ${attempt + 1} failed: ${err.message}`);
            }
        }
    }
    throw lastError || new Error('Whisper failed after all retries');
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
        .eq('lesson_id', lessonId)
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

        // 3. Transcribe: Whisper FIRST (most accurate), Gemini fallback
        if (buffer.byteLength <= WHISPER_MAX_BYTES) {
            // Within Whisper size limit → try Whisper first
            try {
                transcription = await transcribeWithWhisper(buffer, fileName);
            } catch (whisperErr: any) {
                console.warn(`[Audio] ⚠️ Whisper failed: ${whisperErr.message}. Falling back to Gemini...`);
                // Permanent billing error = don't try Gemini either (same cost issue likely)
                if (whisperErr.message?.includes('billing_not_active') || whisperErr.message?.includes('invalid_api_key')) {
                    // Still try Gemini as it uses a different key
                }
                transcription = await transcribeWithGemini(buffer, fileName);
            }
        } else {
            // File too large for Whisper → Gemini only
            console.log(`[Audio] File ${fileSizeMB.toFixed(1)}MB exceeds Whisper limit (25MB). Using Gemini directly.`);
            transcription = await transcribeWithGemini(buffer, fileName);
        }

        if (!transcription || transcription.trim().length < 50) {
            throw new Error('لم يتم التعرف على محتوى صوتي — التفريغ فارغ أو غير كافٍ');
        }

        console.log(`[Audio] Final: ${transcription.length} chars`);

        // 4. Cache
        try {
            await supabase.from('file_hashes')
                .upsert({ content_hash: contentHash, lesson_id: lessonId, source_type: 'audio', file_path: filePath, transcription },
                    { onConflict: 'lesson_id,content_hash' });
        } catch (e) { console.warn('[Audio] Cache failed (non-fatal)'); }
    }

    // 5. Chunk
    const chunks = chunkText(transcription);
    if (chunks.length === 0) throw new Error('No chunks');

    // 6. Save
    await supabase.from('document_sections').delete()
        .eq('lesson_id', lessonId)
        .eq('source_type', 'audio')
        .eq('source_file_id', filePath);

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
