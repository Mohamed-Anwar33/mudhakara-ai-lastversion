import type { SupabaseClient } from '@supabase/supabase-js';
import { processPdfJob } from './pdf-processor.js';
import { embedLessonSections } from './embeddings.js';
import { generateLessonAnalysis } from './analysis.js';

/**
 * Book-to-Lessons Auto Segmenter
 *
 * Takes a FULL textbook PDF → uses AI to detect lesson/chapter
 * boundaries → creates individual lesson records → feeds each into the
 * existing AI pipeline (extract → embed → analyze).
 *
 * Detection Strategy (Multi-Model):
 * ──────────────────────────────────
 * 1. PRIMARY: Gemini Vision (best for Arabic PDFs, handles large files)
 * 2. FALLBACK: GPT-4o Vision (if Gemini fails or quality is poor)
 * 3. Quality Validation: checks page coverage, overlaps, gaps
 * 4. Cross-reference: if both models succeed, pick the best result
 * 5. Last resort: equal-page splitting (~10 pages per lesson)
 *
 * For each detected lesson we:
 *   a) Create a `lessons` row in the DB
 *   b) Extract only that lesson's pages
 *   c) Generate embeddings
 *   d) Run full analysis (summary, focus, quizzes)
 */

// ─── Types ──────────────────────────────────────────────

export interface DetectedLesson {
    title: string;
    startPage: number;
    endPage: number;
    description?: string;
}

export interface SegmentationResult {
    totalPages: number;
    lessonsDetected: number;
    lessons: Array<{
        id: string;
        title: string;
        startPage: number;
        endPage: number;
        status: 'created' | 'processed' | 'analyzed' | 'failed';
        error?: string;
    }>;
    method: 'gemini' | 'gpt4o' | 'cross-validated' | 'fallback-split';
}

// ─── Constants ──────────────────────────────────────────

const FALLBACK_PAGES_PER_LESSON = 10;
const MAX_LESSONS_DETECTED = 50;
const MIN_LESSONS_DETECTED = 1;
const MIN_QUALITY_SCORE = 0.5;  // 50% page coverage threshold

// ─── Shared Prompt ──────────────────────────────────────

function buildDetectionPrompt(pageCount: number): string {
    return `أنت خبير في تحليل الكتب المدرسية. سأعطيك ملف PDF لكتاب مدرسي كامل (${pageCount} صفحة).

المطلوب: حدد كل درس أو فصل أو وحدة في الكتاب.

لكل درس أعطني:
1. **title**: عنوان الدرس بالضبط كما هو مكتوب في الكتاب
2. **startPage**: رقم الصفحة التي يبدأ فيها الدرس (1-indexed)
3. **endPage**: رقم آخر صفحة في الدرس (1-indexed)
4. **description**: وصف مختصر لمحتوى الدرس (جملة واحدة)

⚠️ قواعد مهمة:
- حلل الكتاب كاملاً من الصفحة الأولى للأخيرة
- لا تتخطى أي درس أو فصل
- startPage للدرس التالي يجب أن تكون بعد endPage للدرس السابق
- العناوين يجب أن تكون بالضبط كما في الكتاب (لا تعدّل)
- إذا كان هناك مقدمة أو فهرس، لا تعتبرها درساً
- تأكد أن أرقام الصفحات صحيحة ومتسلسلة
- أعد النتيجة كـ JSON array فقط

الصيغة المطلوبة (JSON فقط):
[
  { "title": "عنوان الدرس", "startPage": 1, "endPage": 15, "description": "وصف مختصر" },
  ...
]`;
}

// ─── Response Parser & Sanitizer ────────────────────────

function parseAndSanitize(content: string, pageCount: number): DetectedLesson[] {
    let lessons: DetectedLesson[];

    try {
        lessons = JSON.parse(content);
    } catch {
        const match = content.match(/```json\s*([\s\S]*?)```/);
        if (match) {
            lessons = JSON.parse(match[1]);
        } else {
            throw new Error(`Bad JSON: ${content.substring(0, 300)}`);
        }
    }

    if (!Array.isArray(lessons)) throw new Error('Response is not an array');

    lessons = lessons
        .filter(l => l.title && typeof l.startPage === 'number' && typeof l.endPage === 'number')
        .map(l => ({
            title: String(l.title).trim(),
            startPage: Math.max(1, Math.min(l.startPage, pageCount)),
            endPage: Math.max(1, Math.min(l.endPage, pageCount)),
            description: l.description ? String(l.description).trim() : undefined
        }))
        .filter(l => l.endPage >= l.startPage)
        .slice(0, MAX_LESSONS_DETECTED);

    lessons.sort((a, b) => a.startPage - b.startPage);
    return lessons;
}

// ─── Quality Scorer ─────────────────────────────────────

interface QualityReport {
    score: number;       // 0.0 – 1.0
    pageCoverage: number;
    hasOverlaps: boolean;
    hasLargeGaps: boolean;
    avgPagesPerLesson: number;
    issues: string[];
}

function assessQuality(lessons: DetectedLesson[], pageCount: number): QualityReport {
    const issues: string[] = [];
    if (lessons.length === 0) return { score: 0, pageCoverage: 0, hasOverlaps: false, hasLargeGaps: false, avgPagesPerLesson: 0, issues: ['No lessons'] };

    // 1. Page coverage: what % of the book is covered?
    const coveredPages = new Set<number>();
    for (const l of lessons) {
        for (let p = l.startPage; p <= l.endPage; p++) coveredPages.add(p);
    }
    const pageCoverage = coveredPages.size / pageCount;
    if (pageCoverage < 0.5) issues.push(`Low coverage: ${(pageCoverage * 100).toFixed(0)}%`);

    // 2. Overlaps: any two lessons share pages?
    let hasOverlaps = false;
    for (let i = 1; i < lessons.length; i++) {
        if (lessons[i].startPage <= lessons[i - 1].endPage) {
            hasOverlaps = true;
            issues.push(`Overlap: "${lessons[i - 1].title}" & "${lessons[i].title}"`);
        }
    }

    // 3. Large gaps: more than 5 pages between consecutive lessons?
    let hasLargeGaps = false;
    for (let i = 1; i < lessons.length; i++) {
        const gap = lessons[i].startPage - lessons[i - 1].endPage - 1;
        if (gap > 5) {
            hasLargeGaps = true;
            issues.push(`Gap of ${gap} pages between "${lessons[i - 1].title}" & "${lessons[i].title}"`);
        }
    }

    // 4. Average pages per lesson (sanity check)
    const totalLessonPages = lessons.reduce((s, l) => s + (l.endPage - l.startPage + 1), 0);
    const avgPagesPerLesson = totalLessonPages / lessons.length;
    if (avgPagesPerLesson < 2) issues.push(`Avg ${avgPagesPerLesson.toFixed(1)} pages/lesson — too small`);
    if (avgPagesPerLesson > pageCount * 0.5) issues.push(`Avg ${avgPagesPerLesson.toFixed(1)} pages/lesson — too large`);

    // 5. Score (0-1)
    let score = pageCoverage;
    if (hasOverlaps) score *= 0.7;
    if (hasLargeGaps) score *= 0.85;
    if (lessons.length < 2 && pageCount > 20) score *= 0.5;

    return { score, pageCoverage, hasOverlaps, hasLargeGaps, avgPagesPerLesson, issues };
}

// ─── Model 1: Gemini Vision ─────────────────────────────

async function detectWithGemini(buffer: Buffer, pageCount: number): Promise<DetectedLesson[]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const base64 = buffer.toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    console.log(`[BookSegmenter] 🔍 Gemini Vision: detecting lessons in ${pageCount}-page PDF...`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: buildDetectionPrompt(pageCount) },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 16384,
                responseMimeType: 'application/json'
            }
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!content) throw new Error('Gemini empty response');

    const lessons = parseAndSanitize(content, pageCount);
    console.log(`[BookSegmenter] Gemini found ${lessons.length} lessons`);
    return lessons;
}

// ─── Model 2: GPT-4o Vision (Fallback) ──────────────────

async function detectWithGPT4o(buffer: Buffer, pageCount: number): Promise<DetectedLesson[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    // GPT-4o only accepts images, not PDFs directly.
    // We send a text description + ask it to analyze based on page count.
    // For actual PDF Vision, we use a workaround: convert first/last pages to base64 image
    // OR rely on the text prompt with context about page count.

    console.log(`[BookSegmenter] 🔍 GPT-4o: detecting lessons in ${pageCount}-page PDF...`);

    // Strategy: Send the PDF as base64 in a data URL — GPT-4o-supports PDF input via URL
    const base64 = buffer.toString('base64');

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
                    role: 'user',
                    content: [
                        { type: 'text', text: buildDetectionPrompt(pageCount) },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:application/pdf;base64,${base64}`
                            }
                        }
                    ]
                }
            ],
            temperature: 0.1,
            max_tokens: 16384,
            response_format: { type: 'json_object' }
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GPT-4o (${response.status}): ${errText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('GPT-4o empty response');

    // GPT-4o with json_object mode wraps arrays in an object like { "lessons": [...] }
    let parsed: any;
    try { parsed = JSON.parse(content); } catch {
        throw new Error(`GPT-4o bad JSON: ${content.substring(0, 300)}`);
    }

    // Handle both { lessons: [...] } and direct [...]
    const rawArray = Array.isArray(parsed) ? parsed : (parsed.lessons || parsed.chapters || parsed.data || []);
    if (!Array.isArray(rawArray)) throw new Error('GPT-4o: could not find lessons array');

    const lessons = parseAndSanitize(JSON.stringify(rawArray), pageCount);
    console.log(`[BookSegmenter] GPT-4o found ${lessons.length} lessons`);
    return lessons;
}

// ─── Multi-Model Orchestrator ───────────────────────────

/**
 * Detects lesson boundaries using multiple AI models with quality validation.
 * 
 * Flow:
 * 1. Try Gemini → validate quality
 * 2. If quality is HIGH (≥0.7) → use Gemini result
 * 3. If quality is MEDIUM (0.5-0.7) → try GPT-4o too, pick best
 * 4. If Gemini FAILS → try GPT-4o alone
 * 5. If both fail → throw (caller will use fallback split)
 */
async function detectLessonBoundaries(
    buffer: Buffer,
    pageCount: number
): Promise<{ lessons: DetectedLesson[]; model: 'gemini' | 'gpt4o' | 'cross-validated' }> {

    let geminiResult: DetectedLesson[] | null = null;
    let geminiQuality: QualityReport | null = null;
    let gpt4oResult: DetectedLesson[] | null = null;
    let gpt4oQuality: QualityReport | null = null;

    // ── Step 1: Try Gemini ──────────────────────────────
    try {
        geminiResult = await detectWithGemini(buffer, pageCount);
        geminiQuality = assessQuality(geminiResult, pageCount);
        console.log(`[BookSegmenter] Gemini quality: ${(geminiQuality.score * 100).toFixed(0)}% (${geminiResult.length} lessons, ${(geminiQuality.pageCoverage * 100).toFixed(0)}% coverage)`);
        if (geminiQuality.issues.length > 0) {
            console.log(`[BookSegmenter]   Issues: ${geminiQuality.issues.join(', ')}`);
        }

        // HIGH quality → use directly
        if (geminiQuality.score >= 0.7) {
            console.log(`[BookSegmenter] ✅ Gemini HIGH quality — using directly`);
            logLessons(geminiResult, 'Gemini');
            return { lessons: geminiResult, model: 'gemini' };
        }

        console.log(`[BookSegmenter] ⚠️ Gemini MEDIUM quality — cross-checking with GPT-4o...`);
    } catch (geminiErr: any) {
        console.warn(`[BookSegmenter] ❌ Gemini failed: ${geminiErr.message}`);
    }

    // ── Step 2: Try GPT-4o ──────────────────────────────
    try {
        gpt4oResult = await detectWithGPT4o(buffer, pageCount);
        gpt4oQuality = assessQuality(gpt4oResult, pageCount);
        console.log(`[BookSegmenter] GPT-4o quality: ${(gpt4oQuality.score * 100).toFixed(0)}% (${gpt4oResult.length} lessons, ${(gpt4oQuality.pageCoverage * 100).toFixed(0)}% coverage)`);
        if (gpt4oQuality.issues.length > 0) {
            console.log(`[BookSegmenter]   Issues: ${gpt4oQuality.issues.join(', ')}`);
        }
    } catch (gptErr: any) {
        console.warn(`[BookSegmenter] ❌ GPT-4o failed: ${gptErr.message}`);
    }

    // ── Step 3: Pick best result ────────────────────────
    if (geminiResult && gpt4oResult && geminiQuality && gpt4oQuality) {
        // Both succeeded — pick higher quality
        if (geminiQuality.score >= gpt4oQuality.score) {
            console.log(`[BookSegmenter] ✅ Cross-validated: Gemini wins (${(geminiQuality.score * 100).toFixed(0)}% vs ${(gpt4oQuality.score * 100).toFixed(0)}%)`);
            logLessons(geminiResult, 'Final (Gemini)');
            return { lessons: geminiResult, model: 'cross-validated' };
        } else {
            console.log(`[BookSegmenter] ✅ Cross-validated: GPT-4o wins (${(gpt4oQuality.score * 100).toFixed(0)}% vs ${(geminiQuality.score * 100).toFixed(0)}%)`);
            logLessons(gpt4oResult, 'Final (GPT-4o)');
            return { lessons: gpt4oResult, model: 'cross-validated' };
        }
    }

    if (geminiResult && geminiQuality && geminiQuality.score >= MIN_QUALITY_SCORE) {
        console.log(`[BookSegmenter] ✅ Using Gemini only (GPT-4o unavailable)`);
        logLessons(geminiResult, 'Gemini');
        return { lessons: geminiResult, model: 'gemini' };
    }

    if (gpt4oResult && gpt4oQuality && gpt4oQuality.score >= MIN_QUALITY_SCORE) {
        console.log(`[BookSegmenter] ✅ Using GPT-4o only (Gemini unavailable)`);
        logLessons(gpt4oResult, 'GPT-4o');
        return { lessons: gpt4oResult, model: 'gpt4o' };
    }

    // Both failed or both below quality threshold
    throw new Error('Both AI models failed or produced low-quality results');
}

function logLessons(lessons: DetectedLesson[], source: string): void {
    for (const l of lessons) {
        console.log(`  📖 [${source}] "${l.title}" (pages ${l.startPage}-${l.endPage})`);
    }
}

// ─── Fallback: Equal Page Split ─────────────────────────

function fallbackSplit(pageCount: number): DetectedLesson[] {
    const lessons: DetectedLesson[] = [];
    const pagesPerLesson = FALLBACK_PAGES_PER_LESSON;
    let page = 1;
    let lessonNum = 1;

    while (page <= pageCount) {
        const endPage = Math.min(page + pagesPerLesson - 1, pageCount);
        lessons.push({
            title: `الدرس ${lessonNum}`,
            startPage: page,
            endPage,
            description: `صفحات ${page} إلى ${endPage}`
        });
        page = endPage + 1;
        lessonNum++;
    }

    console.log(`[BookSegmenter] ⚠️ Fallback: split into ${lessons.length} lessons (${pagesPerLesson} pages each)`);
    return lessons;
}

// ─── PDF Page Count Helper ──────────────────────────────

async function getPageCount(buffer: Buffer): Promise<number> {
    try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        const result = await parser.getText();
        const count = result.pages.length;
        await parser.destroy();
        return count || 1;
    } catch {
        // Rough estimate: ~3KB per page for typical Arabic textbooks
        return Math.max(1, Math.round(buffer.byteLength / 3000));
    }
}

// ─── Per-Lesson PDF Extraction ──────────────────────────

/**
 * Extract text for a specific page range from the PDF using Gemini Vision.
 * This creates chunks in document_sections for the given lessonId.
 */
async function extractLessonPages(
    supabase: SupabaseClient<any, any, any>,
    buffer: Buffer,
    lessonId: string,
    startPage: number,
    endPage: number,
    totalPages: number
): Promise<{ chunksCreated: number; totalChars: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const base64 = buffer.toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    console.log(`[BookSegmenter] 📄 Extracting pages ${startPage}-${endPage} for lesson ${lessonId}...`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    {
                        text: `استخرج النص الموجود فقط في الصفحات من ${startPage} إلى ${endPage} من هذا الملف PDF (إجمالي ${totalPages} صفحة).

القواعد:
- استخرج النص من الصفحات ${startPage} إلى ${endPage} فقط، لا تستخرج من صفحات أخرى
- اكتب النص العربي كما هو بالضبط بدون تعديل
- حافظ على ترتيب الفقرات والعناوين
- حافظ على الترقيم والتنسيق
- لا تضف أي تعليقات أو شروحات
- لا تختصر — اكتب كل كلمة
- أخرج النص المستخرج فقط`
                    },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini extract: ${data.error?.message || response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text.length < 50) {
        console.warn(`[BookSegmenter] ⚠️ Very short extraction (${text.length} chars) for pages ${startPage}-${endPage}`);
    }

    // Use the existing chunker to chunk and store
    const { chunkText, linkChunks } = await import('./chunker');
    const chunks = chunkText(text);

    if (chunks.length === 0) {
        return { chunksCreated: 0, totalChars: text.length };
    }

    // Clear old sections for this lesson (in case of re-run)
    await supabase.from('document_sections').delete()
        .eq('lesson_id', lessonId).eq('source_type', 'pdf');

    const contentHash = `book-segment-${lessonId}-${startPage}-${endPage}`;
    const sectionsToInsert = chunks.map(chunk => ({
        lesson_id: lessonId,
        content: chunk.content,
        source_type: 'pdf' as const,
        source_file_id: `book-pages-${startPage}-${endPage}`,
        chunk_index: chunk.chunkIndex,
        metadata: {
            content_hash: contentHash,
            start_char: chunk.metadata.startChar,
            end_char: chunk.metadata.endChar,
            token_estimate: chunk.metadata.tokenEstimate,
            extraction_method: 'gemini-vision-segment',
            page_range: { start: startPage, end: endPage }
        }
    }));

    const { data: inserted, error: insertError } = await supabase
        .from('document_sections').insert(sectionsToInsert).select('id');
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

    // Link chunks
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

    console.log(`[BookSegmenter] ✅ Extracted ${inserted?.length || 0} chunks (${text.length} chars) for pages ${startPage}-${endPage}`);
    return { chunksCreated: inserted?.length || 0, totalChars: text.length };
}

// ─── Main Orchestrator ──────────────────────────────────

/**
 * Main entry point: Segments a full textbook PDF into individual lessons.
 *
 * Flow:
 * 1. Download PDF from Storage
 * 2. Detect lesson boundaries (AI or fallback)
 * 3. Create lesson records in DB
 * 4. For each lesson: extract pages → embed → analyze
 */
export async function segmentBook(
    supabase: SupabaseClient<any, any, any>,
    subjectId: string,
    userId: string,
    filePath: string,
    options: {
        autoAnalyze?: boolean;    // default: true — run full pipeline per lesson
        autoEmbed?: boolean;      // default: true — generate embeddings
    } = {}
): Promise<SegmentationResult> {

    const autoAnalyze = options.autoAnalyze !== false;
    const autoEmbed = options.autoEmbed !== false;

    console.log(`[BookSegmenter] 📚 Starting book segmentation`);
    console.log(`[BookSegmenter]    Subject: ${subjectId}`);
    console.log(`[BookSegmenter]    File: ${filePath}`);

    // ═══ Step 1: Download PDF ═══════════════════════════════
    const { data: fileData, error: downloadError } = await supabase.storage
        .from('homework-uploads').download(filePath);
    if (downloadError || !fileData) throw new Error(`Download failed: ${downloadError?.message}`);

    const buffer = Buffer.from(await fileData.arrayBuffer());
    console.log(`[BookSegmenter] Downloaded: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);

    // ═══ Step 2: Get page count ═════════════════════════════
    const pageCount = await getPageCount(buffer);
    console.log(`[BookSegmenter] PDF has ${pageCount} pages`);

    // ═══ Step 3: Detect lesson boundaries ═══════════════════
    let detectedLessons: DetectedLesson[];
    let method: SegmentationResult['method'];

    try {
        const detection = await detectLessonBoundaries(buffer, pageCount);
        detectedLessons = detection.lessons;
        if (detectedLessons.length < MIN_LESSONS_DETECTED) {
            throw new Error(`Only ${detectedLessons.length} lessons detected — too few`);
        }
        method = detection.model;
    } catch (aiErr: any) {
        console.warn(`[BookSegmenter] ⚠️ AI detection failed: ${aiErr.message}. Using fallback.`);
        detectedLessons = fallbackSplit(pageCount);
        method = 'fallback-split';
    }

    console.log(`[BookSegmenter] 📋 ${detectedLessons.length} lessons detected via ${method}`);

    // ═══ Step 4: Create lessons + process each ══════════════
    const results: SegmentationResult['lessons'] = [];

    for (let i = 0; i < detectedLessons.length; i++) {
        const detected = detectedLessons[i];
        const lessonId = crypto.randomUUID();

        console.log(`\n[BookSegmenter] ═══ Lesson ${i + 1}/${detectedLessons.length}: "${detected.title}" ═══`);

        try {
            // 4a. Create lesson record in DB
            const { error: createError } = await supabase
                .from('lessons')
                .insert({
                    id: lessonId,
                    course_id: subjectId,
                    lesson_title: detected.title,
                    created_by: userId,
                    created_at: new Date().toISOString(),
                    sources: [{
                        id: `segment-${lessonId}`,
                        type: 'pdf',
                        name: `pages ${detected.startPage}-${detected.endPage}`,
                        content: '[auto-segmented]'
                    }],
                    request_type: 'study',
                    analysis_status: 'pending',
                    student_text: JSON.stringify({
                        auto_segmented: true,
                        source_file: filePath,
                        page_range: { start: detected.startPage, end: detected.endPage },
                        description: detected.description || null,
                        segmentation_method: method
                    })
                });

            if (createError) {
                throw new Error(`Create lesson: ${createError.message}`);
            }

            console.log(`[BookSegmenter] ✅ Created lesson: ${lessonId}`);

            // 4b. Extract text for this lesson's page range
            const extraction = await extractLessonPages(
                supabase, buffer, lessonId,
                detected.startPage, detected.endPage, pageCount
            );

            if (extraction.chunksCreated === 0) {
                console.warn(`[BookSegmenter] ⚠️ No chunks for "${detected.title}" — marking as failed`);
                await supabase.from('lessons')
                    .update({ analysis_status: 'failed' })
                    .eq('id', lessonId);
                results.push({
                    id: lessonId, title: detected.title,
                    startPage: detected.startPage, endPage: detected.endPage,
                    status: 'failed', error: 'No content extracted'
                });
                continue;
            }

            let currentStatus: 'created' | 'processed' | 'analyzed' = 'processed';

            // 4c. Generate embeddings (optional)
            if (autoEmbed) {
                try {
                    console.log(`[BookSegmenter] 🔄 Generating embeddings for "${detected.title}"...`);
                    await embedLessonSections(supabase, lessonId);
                } catch (embedErr: any) {
                    console.warn(`[BookSegmenter] ⚠️ Embeddings failed (non-fatal): ${embedErr.message}`);
                }
            }

            // 4d. Run analysis (optional)
            if (autoAnalyze) {
                try {
                    console.log(`[BookSegmenter] 🧠 Analyzing "${detected.title}"...`);
                    await generateLessonAnalysis(supabase, lessonId);
                    currentStatus = 'analyzed';
                } catch (analysisErr: any) {
                    console.warn(`[BookSegmenter] ⚠️ Analysis failed (non-fatal): ${analysisErr.message}`);
                }
            }

            results.push({
                id: lessonId, title: detected.title,
                startPage: detected.startPage, endPage: detected.endPage,
                status: currentStatus
            });

        } catch (err: any) {
            console.error(`[BookSegmenter] ❌ Lesson "${detected.title}" failed: ${err.message}`);
            results.push({
                id: lessonId, title: detected.title,
                startPage: detected.startPage, endPage: detected.endPage,
                status: 'failed', error: err.message
            });
        }
    }

    // ═══ Step 5: Summary ════════════════════════════════════
    const succeeded = results.filter(r => r.status !== 'failed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    console.log(`\n[BookSegmenter] ════════════════════════════════════════`);
    console.log(`[BookSegmenter] 📚 Segmentation complete!`);
    console.log(`[BookSegmenter]    Total pages: ${pageCount}`);
    console.log(`[BookSegmenter]    Lessons detected: ${detectedLessons.length}`);
    console.log(`[BookSegmenter]    Succeeded: ${succeeded}`);
    console.log(`[BookSegmenter]    Failed: ${failed}`);
    console.log(`[BookSegmenter]    Method: ${method}`);
    console.log(`[BookSegmenter] ════════════════════════════════════════\n`);

    return {
        totalPages: pageCount,
        lessonsDetected: detectedLessons.length,
        lessons: results,
        method
    };
}
