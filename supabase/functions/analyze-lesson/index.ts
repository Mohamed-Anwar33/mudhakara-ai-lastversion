import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { jsonrepair } from 'https://esm.sh/jsonrepair@3.4.0';
import { corsHeaders, jsonResponse, errorResponse } from '../_shared/utils.ts';

/**
 * Edge Function: analyze-lesson
 * 
 * Performs full AI analysis on a lesson:
 * 1. Fetches all document_sections for the lesson
 * 2. Builds focus map (audio vs PDF similarity)
 * 3. Calls Gemini/GPT-4o for analysis
 * 4. Returns summary + focus points + quizzes
 * 
 * Timeout: 150s (Supabase free tier)
 */

// ─── System Prompt Builder ──────────────────────────────

function buildSystemPrompt(contentLength: number) {
    const numFocus = contentLength > 50000 ? 12 : contentLength > 20000 ? 8 : 5;
    const numQuiz = contentLength > 50000 ? 15 : contentLength > 20000 ? 10 : 5;
    const numEssay = contentLength > 50000 ? 5 : 3;
    const isLargeBook = contentLength > 100000;

    if (isLargeBook) {
        return `أنت أستاذ ومحلل تعليمي ذكي ومتخصص. حلل المحتوى التالي (كتاب ضخم/ملزمة) وأخرج JSON بالصيغة التالية بدقة:
{
  "chapters": [
    {
      "title": "عنوان المحاضرة أو الفصل",
      "summary": "شرح تفصيلي شامل من نص الكتاب لهذه المحاضرة/الفصل فقط (يمنع الاختصار تماماً، اكتب كل التفاصيل)."
    }
  ],
  "focusPoints": [{"title": "عنوان النقطة", "details": "شرح تفصيلي مع أمثلة"}],
  "quizzes": [{"question": "السؤال", "type": "mcq أو tf", "options": ["أ", "ب", "ج", "د"], "correctAnswer": 0, "explanation": "التفسير"}],
  "essayQuestions": [{"question": "سؤال مقالي", "idealAnswer": "إجابة نموذجية مفصلة"}]
}

📌 المطلوب:
- chapters: **ابحث أولاً عن الفهرس (Table of Contents)** إن وُجد لاستخدامه كخريطة. استخرج **كل الدروس والفصول** من الكتاب من البداية للنهاية دون تخطي أي صفحة. يجب وضع كل فصل في عنصر مستقل داخل مصفوفة \`chapters\`.
- focusPoints: ${numFocus} نقاط على الأقل — النقاط المحورية في الكتاب كاملاً.
- quizzes: ${numQuiz} سؤال متنوع.
- essayQuestions: ${numEssay} أسئلة مقالية.

⚠️ قواعد حاسمة جداً:
- إياك أن تختصر الكتاب في فصل واحد. استخرج جميع الفصول/المحاضرات (الفصل الأول، الثاني، الثالث، إلخ) حتى نهاية النص.
- أخرج JSON فقط. لا تكتب أي شيء خارج JSON.`;
    }

    return `أنت أستاذ ومحلل تعليمي ذكي ومتخصص. حلل المحتوى التالي وأخرج JSON بالصيغة:
{
  "summary": "ملخص شامل ومفصل يغطي كل المواضيع. استخدم Markdown مع عناوين وقوائم.",
  "focusPoints": [{"title": "عنوان النقطة", "details": "شرح تفصيلي مع أمثلة"}],
  "quizzes": [{"question": "السؤال", "type": "mcq أو tf", "options": ["أ", "ب", "ج", "د"], "correctAnswer": 0, "explanation": "التفسير"}],
  "essayQuestions": [{"question": "سؤال مقالي", "idealAnswer": "إجابة نموذجية مفصلة"}]
}

📌 المطلوب:
- summary: ملخص شامل ومفصل يغطي كل المواضيع. ركّز أكثر على الأجزاء المميزة بـ ⭐
- focusPoints: ${numFocus} نقاط على الأقل — النقاط المهمة والمحورية التي يجب التركيز عليها
- quizzes: ${numQuiz} سؤال متنوع (صح/خطأ + اختياري)
- essayQuestions: ${numEssay} أسئلة مقالية مع إجابات نموذجية

⚠️ أخرج JSON فقط. لا تكتب أي شيء خارج JSON.`;
}

// ─── JSON Repair ────────────────────────────────────────

function repairTruncatedJSON(raw: string): any | null {
    try { return JSON.parse(raw); } catch { }

    let text = raw.trim();
    const m = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
    if (m) text = m[1].trim();

    try {
        const repaired = jsonrepair(text);
        return JSON.parse(repaired);
    } catch (e: any) {
        console.warn(`[JSONRepair] Failed: ${e.message}`);
        return null;
    }
}

// ─── Normalize Response ─────────────────────────────────

function normalizeResponse(parsed: any): any {
    if (parsed.focus_points && !parsed.focusPoints) parsed.focusPoints = parsed.focus_points;
    if (parsed.essay_questions && !parsed.essayQuestions) parsed.essayQuestions = parsed.essay_questions;
    if (!parsed.focusPoints) parsed.focusPoints = [];
    if (!parsed.quizzes) parsed.quizzes = [];
    if (!parsed.essayQuestions) parsed.essayQuestions = [];

    // If the AI generated an array of chapters (large book format), merge them into the summary
    if (parsed.chapters && Array.isArray(parsed.chapters) && parsed.chapters.length > 0) {
        parsed.summary = parsed.chapters.map((c: any) => `## ${c.title || 'فصل'}\n\n${c.summary || ''}`).join('\n\n---\n\n');
    }

    if (!parsed.summary) parsed.summary = '';

    // Normalize quiz answers
    for (const q of parsed.quizzes) {
        if (typeof q.correctAnswer === 'string') {
            const idx = (q.options || []).indexOf(q.correctAnswer);
            q.correctAnswer = idx >= 0 ? idx : 0;
        }
    }
    return parsed;
}

// ─── AI Calls ───────────────────────────────────────────

async function callGeminiAnalysis(systemPrompt: string, userPrompt: string, apiKey: string): Promise<{ parsed: any; tokens: number }> {
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

    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
    if (!content) throw new Error('Gemini empty response');

    const parsed = repairTruncatedJSON(content);
    if (!parsed) throw new Error(`Bad JSON from Gemini: ${content.substring(0, 200)}`);

    return { parsed, tokens: data.usageMetadata?.totalTokenCount || 0 };
}

async function callGPT4oAnalysis(systemPrompt: string, userPrompt: string, apiKey: string): Promise<{ parsed: any; tokens: number }> {
    // GPT-4o 128k context allows ~400k - 500k Arabic chars. 
    // We already truncated it in the fallback logic before calling this, but keep a safety net.
    const MAX_CHARS = 400000;
    const truncated = userPrompt.length > MAX_CHARS ? userPrompt.substring(0, MAX_CHARS) + '\n...(اقتطاع)' : userPrompt;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: truncated }],
            temperature: 0.2, max_tokens: 16384, response_format: { type: 'json_object' }
        })
    });

    if (!response.ok) throw new Error(`GPT-4o: ${response.status}`);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('GPT-4o empty');
    return { parsed: JSON.parse(content), tokens: result.usage?.total_tokens || 0 };
}

// ─── Focus Extraction ───────────────────────────────────

async function buildFocusMap(supabase: any, lessonId: string): Promise<Set<string>> {
    const { data: sections } = await supabase.from('document_sections')
        .select('id, content, source_type, embedding, chunk_index')
        .eq('lesson_id', lessonId);

    if (!sections) return new Set();

    const audio = sections.filter((s: any) => s.source_type === 'audio' && s.embedding);
    const pdf = sections.filter((s: any) => s.source_type === 'pdf');

    if (audio.length === 0) return new Set(pdf.map((s: any) => s.id)); // No audio = all focused

    const focusedIds = new Set<string>();
    const CONCURRENCY = 5;

    for (let i = 0; i < audio.length; i += CONCURRENCY) {
        const batch = audio.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (audioSec: any) => {
            const embedding = typeof audioSec.embedding === 'string'
                ? audioSec.embedding : JSON.stringify(audioSec.embedding);

            const { data: matches } = await supabase.rpc('match_sections', {
                query_embedding: embedding,
                match_threshold: 0.4,
                match_count: 10,
                filter_lesson_id: lessonId,
                filter_source: 'pdf'
            });

            for (const m of (matches || [])) {
                if (m.similarity > 0.45) focusedIds.add(m.id);
            }
        }));
    }

    console.log(`[Focus] ${focusedIds.size} sections matched`);
    return focusedIds;
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
        const { lessonId } = body;
        if (!lessonId) return errorResponse('Missing lessonId', 400);

        const supabaseUrl = Deno.env.get('APP_SUPABASE_URL') || Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('APP_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
        const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';

        console.log(`[Analysis] Config check - URL: ${supabaseUrl ? '✅' : '❌'}, Key: ${supabaseKey ? '✅' : '❌'}, Gemini: ${geminiKey ? '✅' : '❌'}`);

        if (!supabaseUrl || !supabaseKey) return errorResponse('Missing Supabase config', 500);
        if (!geminiKey) return errorResponse('Missing GEMINI_API_KEY', 500);

        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. Update status
        await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

        // 2. Fetch all content
        const { data: allSections } = await supabase.from('document_sections')
            .select('id, content, source_type, embedding, chunk_index')
            .eq('lesson_id', lessonId).order('chunk_index');

        if (!allSections || allSections.length === 0) {
            return errorResponse('No content found for this lesson', 400);
        }

        const pdf = allSections.filter((s: any) => s.source_type === 'pdf');
        const audio = allSections.filter((s: any) => s.source_type === 'audio');
        const image = allSections.filter((s: any) => s.source_type === 'image');

        console.log(`[Analysis] Content: ${pdf.length} PDF, ${audio.length} audio, ${image.length} image sections`);

        // 3. Build focus map
        let focusedIds = new Set<string>();
        const audioChars = audio.reduce((sum: number, s: any) => sum + (s.content?.length || 0), 0);
        if (audioChars > 3000) {
            try {
                focusedIds = await buildFocusMap(supabase, lessonId);
            } catch (e: any) {
                console.warn(`[Analysis] Focus failed: ${e.message}`);
            }
        }

        // 4. Build prompt with focus markers
        let userPrompt = '';

        if (pdf.length > 0) {
            userPrompt += '📖 محتوى الكتاب/الملزمة:\n\n';
            for (const s of pdf) {
                const marker = focusedIds.has(s.id) ? '⭐ [ركز المعلم] ' : '';
                userPrompt += marker + s.content + '\n\n';
            }
        }

        if (audio.length > 0) {
            userPrompt += '\n🎙️ شرح المعلم (تفريغ صوتي):\n\n';
            for (const s of audio) userPrompt += s.content + '\n\n';
        }

        if (image.length > 0) {
            userPrompt += '\n📝 ملاحظات السبورة:\n\n';
            for (const s of image) userPrompt += s.content + '\n\n';
        }

        const totalChars = userPrompt.length;
        const systemPrompt = buildSystemPrompt(totalChars);

        // 5. Call AI
        let parsed: any = null;
        let tokensUsed = 0;
        let model = 'unknown';

        try {
            const result = await callGeminiAnalysis(systemPrompt, userPrompt, geminiKey);
            parsed = normalizeResponse(result.parsed);
            tokensUsed = result.tokens;
            model = 'gemini-2.5-flash';
        } catch (e: any) {
            console.warn(`[Analysis] Gemini failed: ${e.message}`);

            // Retry Gemini with focused content if too large, but preserve MUCH more text
            if (userPrompt.length > 50000) {
                try {
                    // Try to preserve up to 800,000 chars (Gemini 2.5 Flash has a 1M token context window, which is ~4M chars)
                    // The failure is likely a timeout or parsing issue, so we send a slightly stripped version
                    const stripped = userPrompt.substring(0, 800000);
                    console.log(`[Analysis] Gemini retry with ${stripped.length} chars...`);
                    const result = await callGeminiAnalysis(systemPrompt, stripped, geminiKey);
                    parsed = normalizeResponse(result.parsed);
                    tokensUsed = result.tokens;
                    model = 'gemini-2.5-flash-retry';
                } catch (e2: any) {
                    console.warn(`[Analysis] Gemini retry failed: ${e2.message}`);
                }
            }

            // GPT-4o limit is strictly 128k tokens (~500k chars), but 60000 chars is too little. Let's send 300,000.
            if (!parsed && openaiKey) {
                const MAX_GPT_CHARS = 300000;
                const truncatedGPTPrompt = userPrompt.length > MAX_GPT_CHARS ? userPrompt.substring(0, MAX_GPT_CHARS) + '\n...(اقتطاع)' : userPrompt;
                console.log(`[Analysis] Falling back to GPT-4o with ${truncatedGPTPrompt.length} chars...`);
                const result = await callGPT4oAnalysis(systemPrompt, truncatedGPTPrompt, openaiKey);
                parsed = normalizeResponse(result.parsed);
                tokensUsed = result.tokens;
                model = 'gpt-4o';
            }
        }

        if (!parsed) {
            await supabase.from('lessons').update({ analysis_status: 'failed' }).eq('id', lessonId);
            return errorResponse('Analysis failed: no valid response from AI models');
        }

        // 6. Build final result
        const analysisResult = {
            summary: parsed.summary,
            focusPoints: parsed.focusPoints,
            quizzes: parsed.quizzes,
            essayQuestions: parsed.essayQuestions,
            metadata: {
                model,
                contentStats: {
                    pdfChars: pdf.reduce((s: number, x: any) => s + (x.content?.length || 0), 0),
                    audioChars,
                    imageChars: image.reduce((s: number, x: any) => s + (x.content?.length || 0), 0),
                    focusMatches: focusedIds.size
                },
                generatedAt: new Date().toISOString(),
                schemaVersion: 6
            }
        };

        // 7. Save to DB
        await supabase.from('lessons').update({
            analysis_result: analysisResult,
            analysis_status: 'completed'
        }).eq('id', lessonId);

        console.log(`[Analysis] ✅ Done: ${model}, ${tokensUsed} tokens, ${parsed.focusPoints?.length || 0} focus, ${parsed.quizzes?.length || 0} quiz`);

        return jsonResponse({ success: true, data: analysisResult });

    } catch (error: any) {
        console.error('Analysis Fatal Error:', error);
        // ✅ Always return CORS headers even on crash
        return new Response(
            JSON.stringify({ error: error.message || 'Analysis failed', stack: error.stack }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    }
});
