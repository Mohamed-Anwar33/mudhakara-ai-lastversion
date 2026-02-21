import type { SupabaseClient } from '@supabase/supabase-js';
import { buildFocusMap } from './focus';

/**
 * Analysis Module — v6 (No Hallucination)
 *
 * KEY FIX: ALWAYS sends ALL content to the AI. Never filters.
 * Focus extraction only MARKS which sections the teacher emphasized,
 * it does NOT remove the rest. This prevents hallucination.
 */

const MAX_CONTENT_CHARS = 2000000;  // 2 million chars — Gemini 2.5 Flash handles ~1M tokens (approx 3-4M chars)
const MAX_VALIDATION_RETRIES = 2;

// ─── Types ──────────────────────────────────────────────

export interface AnalysisResult {
    summary: string;
    focusPoints: Array<{
        title: string;
        details: string;
        evidence?: { pdf_section_ids: string[]; audio_section_ids: string[] };
    }>;
    quizzes: Array<{
        question: string;
        type: string;
        options: string[];
        correctAnswer: number;
        explanation: string;
    }>;
    essayQuestions?: Array<{
        question: string;
        idealAnswer: string;
    }>;
    metadata: {
        model: string;
        contentStats: {
            pdfChars: number;
            audioChars: number;
            imageChars: number;
            method: string;
            focusMatches?: number;
        };
        generatedAt: string;
        schemaVersion: number;
    };
}

// ─── Dynamic Prompt ─────────────────────────────────────

function buildSystemPrompt(totalChars: number): string {
    const isLarge = totalChars > 15000;
    const summaryWords = isLarge ? '1500-3000' : '500-1000';
    const focusCount = isLarge ? '7-15' : '3-7';
    const focusDetailWords = isLarge ? '100-300' : '50-150';
    const quizCount = isLarge ? '10-20' : '5-10';
    const essayCount = isLarge ? '3-5' : '2-3';

    return `أنت مساعد تعليمي خبير. ستتلقى محتوى درس كامل من مصادر متعددة (كتاب + شرح صوتي).

⚠️ قاعدة أساسية: استخدم المحتوى المقدم لك فقط. لا تخترع أو تضف أي معلومات من خارج النص. كل ما تكتبه يجب أن يكون موجوداً في المحتوى المقدم.
${totalChars > 30000 ? '\n⚠️ المحتوى كبير جداً. حلل كل جزء منه بعناية.' : ''}

المطلوب (JSON):

1. **summary** (${summaryWords} كلمة): ملخص شامل ومفصل جداً يغطي:
   - كل المواضيع والمفاهيم والتعريفات الموجودة في المحتوى
   - كل الأمثلة والتطبيقات والقواعد المذكورة فعلاً
   - استخدم عناوين فرعية (##) وتنسيق markdown
   - الأقسام المميزة بـ ⭐ هي ما ركز عليه المعلم — أعطها أولوية

2. **focusPoints** (${focusCount} نقطة):
   - title: عنوان واضح
   - details: شرح تفصيلي (${focusDetailWords} كلمة) من المحتوى الفعلي

3. **quizzes** (${quizCount} سؤال):
   - question: سؤال من المحتوى الفعلي (ليس عام)
   - type: "mcq" أو "tf"
   - options: 4 خيارات دائماً
   - correctAnswer: رقم (0,1,2,3)
   - explanation: شرح

4. **essayQuestions** (${essayCount} سؤال مقالي):
   - question: سؤال يتطلب شرح
   - idealAnswer: الإجابة النموذجية (100-200 كلمة)

⚠️ قواعد:
- correctAnswer = رقم فقط (0,1,2,3)
- options = مصفوفة من 4 دائماً
- كل الأسئلة والملخص من المحتوى المقدم فقط — لا تخترع
- JSON نقي بالعربية بدون \`\`\`json`;
}

// ─── AI Calls ───────────────────────────────────────────

async function callGemini(systemPrompt: string, userPrompt: string): Promise<{ parsed: any; tokensUsed: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    console.log(`[Analysis] Calling Gemini 2.5 Flash (${userPrompt.length} chars)...`);

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + '\n\n--- المحتوى ---\n\n' + userPrompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 65536, responseMimeType: 'application/json' }
            })
        }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!content) throw new Error('Gemini empty');

    let parsed: any;
    try { parsed = JSON.parse(content); } catch {
        const m = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (m) try { parsed = JSON.parse(m[1].trim()); } catch { }
    }
    if (!parsed) throw new Error(`Bad JSON from Gemini: ${content.substring(0, 300)}`);

    const tokens = data.usageMetadata?.totalTokenCount || 0;
    console.log(`[Analysis] ✅ Gemini: ${tokens} tokens, summary ${parsed.summary?.length || 0} chars`);
    return { parsed, tokensUsed: tokens };
}

async function callGPT4o(systemPrompt: string, userPrompt: string): Promise<{ parsed: any; tokensUsed: number }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    // GPT-4o supports 128k tokens (roughly ~400k-500k chars in Arabic). 
    // Increasing truncation limit from 60k to 300k so we don't drop the book or audio.
    const truncated = userPrompt.length > 300000 ? userPrompt.substring(0, 300000) + '\n...(اقتطاع)' : userPrompt;
    console.log(`[Analysis] Calling GPT-4o (${truncated.length} chars)...`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: truncated }],
            temperature: 0.2, max_tokens: 16384, response_format: { type: 'json_object' }
        })
    });

    if (!response.ok) throw new Error(`GPT-4o error (${response.status}): ${await response.text()}`);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('GPT-4o empty');
    return { parsed: JSON.parse(content), tokensUsed: result.usage?.total_tokens || 0 };
}

async function callAI(systemPrompt: string, userPrompt: string): Promise<{ parsed: any; tokensUsed: number }> {
    try { return await callGemini(systemPrompt, userPrompt); }
    catch (e: any) { console.warn(`[Analysis] ⚠️ Gemini: ${e.message}. Trying GPT-4o...`); }
    return await callGPT4o(systemPrompt, userPrompt);
}

// ─── Normalize + Validate ───────────────────────────────

function normalizeResponse(parsed: any): any {
    if (parsed.focus_points && !parsed.focusPoints) { parsed.focusPoints = parsed.focus_points; delete parsed.focus_points; }
    if (parsed.quiz && !parsed.quizzes) { parsed.quizzes = parsed.quiz; delete parsed.quiz; }
    if (parsed.essay_questions && !parsed.essayQuestions) { parsed.essayQuestions = parsed.essay_questions; delete parsed.essay_questions; }

    if (Array.isArray(parsed.quizzes)) {
        parsed.quizzes = parsed.quizzes.map((q: any) => {
            if (!q.options || !Array.isArray(q.options)) q.options = ['أ', 'ب', 'ج', 'د'];
            while (q.options.length < 4) q.options.push('-');
            if (typeof q.correctAnswer === 'string') {
                const idx = q.options.findIndex((o: string) => o === q.correctAnswer || o.includes(q.correctAnswer));
                q.correctAnswer = idx >= 0 ? idx : 0;
            }
            if (!q.type) q.type = 'mcq';
            if (!q.explanation) q.explanation = '';
            return q;
        });
    }
    return parsed;
}

function validateAnalysis(parsed: any): string | null {
    if (typeof parsed.summary !== 'string' || parsed.summary.length < 50) return 'summary قصير';
    if (!Array.isArray(parsed.focusPoints) || parsed.focusPoints.length === 0) return 'focusPoints فارغ';
    if (!Array.isArray(parsed.quizzes) || parsed.quizzes.length < 3) return 'quizzes < 3';
    for (const q of parsed.quizzes) {
        if (!q.question || !q.options) return 'سؤال ناقص';
        if (typeof q.correctAnswer !== 'number') return `correctAnswer not number`;
    }
    return null;
}

// ─── Main ───────────────────────────────────────────────

export async function generateLessonAnalysis(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string
): Promise<AnalysisResult> {

    await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

    try {
        // ═══ Step 1: ALWAYS fetch ALL content ═══════════════════
        console.log(`[Analysis] Fetching all content for lesson ${lessonId}`);
        const { data: allSections, error: fetchErr } = await supabase
            .from('document_sections')
            .select('id, content, chunk_index, source_type')
            .eq('lesson_id', lessonId)
            .order('source_type').order('chunk_index');

        if (fetchErr) throw new Error(`Fetch: ${fetchErr.message}`);

        const sections = {
            pdf: (allSections || []).filter((s: any) => s.source_type === 'pdf'),
            audio: (allSections || []).filter((s: any) => s.source_type === 'audio'),
            image: (allSections || []).filter((s: any) => s.source_type === 'image'),
        };

        const pdfChars = sections.pdf.reduce((s: number, r: any) => s + (r.content?.length || 0), 0);
        const audioChars = sections.audio.reduce((s: number, r: any) => s + (r.content?.length || 0), 0);
        const imageChars = sections.image.reduce((s: number, r: any) => s + (r.content?.length || 0), 0);
        const totalChars = pdfChars + audioChars + imageChars;

        console.log(`[Analysis] Content: ${pdfChars} PDF + ${audioChars} audio + ${imageChars} image = ${totalChars} chars`);
        if (totalChars < 50) throw new Error('لا يوجد محتوى كافٍ');

        // ═══ Step 2: Try focus extraction (markers only) ════════
        let focusedIds = new Set<string>();
        let focusMatches = 0;

        if (audioChars > 3000) {
            try {
                console.log(`[Analysis] 🔍 Building focus map...`);
                const focus = await buildFocusMap(supabase, lessonId);
                focusMatches = focus.stats.matchedPdfChunks;
                console.log(`[Analysis] Focus: ${focusMatches}/${focus.stats.totalPdfChunks} matched`);
                for (const sec of focus.focusPdfSections) focusedIds.add(sec.id);
            } catch (e: any) {
                console.warn(`[Analysis] ⚠️ Focus: ${e.message}`);
            }
        } else {
            console.log(`[Analysis] ⚠️ Audio too short (${audioChars}), skipping focus`);
        }

        // ═══ Step 3: Build prompt with ALL content ══════════════
        let userPrompt = '';

        if (sections.pdf.length > 0) {
            userPrompt += '=== محتوى الكتاب / PDF (كامل) ===\n\n';
            for (const sec of sections.pdf) {
                if (focusedIds.has(sec.id)) {
                    userPrompt += `⭐ [ركّز عليه المعلم] ${sec.content}\n\n`;
                } else {
                    userPrompt += sec.content + '\n\n';
                }
            }
        }

        if (sections.audio.length > 0) {
            userPrompt += '=== شرح المعلم (نص صوتي) ===\n\n';
            for (const sec of sections.audio) userPrompt += sec.content + '\n\n';
        }

        if (sections.image.length > 0) {
            userPrompt += '=== ملاحظات / صور ===\n\n';
            for (const sec of sections.image) userPrompt += sec.content + '\n\n';
        }

        if (userPrompt.length > MAX_CONTENT_CHARS) {
            userPrompt = userPrompt.substring(0, MAX_CONTENT_CHARS) + '\n...(اقتطاع)';
            console.warn(`[Analysis] ⚠️ Content truncated from ${totalChars} to ${MAX_CONTENT_CHARS} chars`);
        }

        const method = focusedIds.size > 0 ? 'all-content+focus' : 'all-content';
        console.log(`[Analysis] Prompt: ${userPrompt.length} chars, method: ${method}`);

        // ═══ Step 4: Call AI ════════════════════════════════════
        const systemPrompt = buildSystemPrompt(totalChars);
        let parsed: any = null;
        let totalTokens = 0;
        let lastErr: string | null = null;

        for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
            const prompt = attempt === 0 ? userPrompt : `رُفض: "${lastErr}". أعد.\n\n${userPrompt}`;
            const result = await callAI(systemPrompt, prompt);
            totalTokens += result.tokensUsed;
            result.parsed = normalizeResponse(result.parsed);
            lastErr = validateAnalysis(result.parsed);
            if (!lastErr) { parsed = result.parsed; break; }
            console.warn(`[Analysis] Validation #${attempt + 1}: ${lastErr}`);
        }

        if (!parsed) throw new Error(`Validation: ${lastErr}`);

        // ═══ Step 5: Save ══════════════════════════════════════
        const analysisResult: AnalysisResult = {
            summary: parsed.summary,
            focusPoints: parsed.focusPoints,
            quizzes: parsed.quizzes,
            essayQuestions: parsed.essayQuestions || [],
            metadata: {
                model: 'gemini-2.5-flash',
                contentStats: { pdfChars, audioChars, imageChars, method, focusMatches },
                generatedAt: new Date().toISOString(),
                schemaVersion: 6
            }
        };

        await supabase.from('lessons')
            .update({ analysis_result: analysisResult, analysis_status: 'completed' })
            .eq('id', lessonId);

        console.log(`[Analysis] ✅ Done: ${totalTokens} tokens, summary=${parsed.summary.length} chars, ${parsed.focusPoints.length} focus, ${parsed.quizzes.length} quiz, ${parsed.essayQuestions?.length || 0} essay`);
        return analysisResult;

    } catch (err: any) {
        console.error(`[Analysis] ❌ ${lessonId}: ${err.message}`);
        await supabase.from('lessons')
            .update({ analysis_status: 'failed', analysis_result: { error: err.message } })
            .eq('id', lessonId);
        throw err;
    }
}

export async function rerunLessonAnalysis(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string
): Promise<AnalysisResult> {
    return generateLessonAnalysis(supabase, lessonId);
}
