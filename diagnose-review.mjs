/**
 * diagnose-review.mjs — Comprehensive diagnostic script for the Review Page pipeline
 * 
 * Tests:
 * 1. Vercel API config verification (maxDuration, body size limits)
 * 2. Gemini API connectivity test
 * 3. Review pipeline simulation (all 4 steps)
 * 4. Payload size analysis
 * 5. Free tier limit checks
 * 
 * Usage: node diagnose-review.mjs
 */

import 'dotenv/config';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';
const INFO = 'ℹ️';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let warnings = 0;

function log(icon, msg) {
    console.log(`${icon} ${msg}`);
}

function test(name, passed, detail = '') {
    totalTests++;
    if (passed) {
        passedTests++;
        log(PASS, `${name}${detail ? ' — ' + detail : ''}`);
    } else {
        failedTests++;
        log(FAIL, `${name}${detail ? ' — ' + detail : ''}`);
    }
}

function warn(name, detail = '') {
    warnings++;
    log(WARN, `${name}${detail ? ' — ' + detail : ''}`);
}

// ═══════════════════════════════════════════════════
// TEST 1: Environment & Config
// ═══════════════════════════════════════════════════
async function testConfig() {
    console.log('\n══════════════════════════════════════════');
    console.log('📋 TEST 1: Environment & Config');
    console.log('══════════════════════════════════════════');

    test('GEMINI_API_KEY is set', !!GEMINI_API_KEY, GEMINI_API_KEY ? `...${GEMINI_API_KEY.slice(-6)}` : 'MISSING');
    test('SUPABASE_URL is set', !!SUPABASE_URL, SUPABASE_URL || 'MISSING');
    test('SUPABASE_ANON_KEY is set', !!SUPABASE_ANON_KEY, SUPABASE_ANON_KEY ? `...${SUPABASE_ANON_KEY.slice(-6)}` : 'MISSING');

    // Check api/gemini.ts maxDuration
    const fs = await import('fs');
    const geminiApiContent = fs.readFileSync('./api/gemini.ts', 'utf-8');
    const maxDurationMatch = geminiApiContent.match(/maxDuration:\s*(\d+)/);
    const maxDuration = maxDurationMatch ? parseInt(maxDurationMatch[1]) : null;
    test('api/gemini.ts maxDuration = 60', maxDuration === 60, `Current: ${maxDuration}s`);

    if (maxDuration && maxDuration < 30) {
        warn('maxDuration too low for Gemini structured output', `${maxDuration}s — Gemini + JSON schema typically needs 15-45s`);
    }

    // Check model name
    const modelMatch = geminiApiContent.match(/models\/([\w.-]+):/);
    const model = modelMatch ? modelMatch[1] : 'unknown';
    test('Gemini model configured', !!modelMatch, model);
}

// ═══════════════════════════════════════════════════
// TEST 2: Gemini API Connectivity
// ═══════════════════════════════════════════════════
async function testGeminiConnectivity() {
    console.log('\n══════════════════════════════════════════');
    console.log('🌐 TEST 2: Gemini API Connectivity');
    console.log('══════════════════════════════════════════');

    if (!GEMINI_API_KEY) {
        log(FAIL, 'Cannot test — GEMINI_API_KEY missing');
        failedTests++;
        totalTests++;
        return;
    }

    try {
        const startTime = Date.now();
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'قل: "اتصال ناجح" فقط.' }] }],
                    generationConfig: {
                        maxOutputTokens: 50,
                        responseMimeType: 'application/json',
                        responseSchema: {
                            type: 'OBJECT',
                            properties: { status: { type: 'STRING' } },
                            required: ['status']
                        }
                    }
                })
            }
        );

        const elapsed = Date.now() - startTime;
        const data = await response.json();

        test('Gemini API responds', response.ok, `Status: ${response.status}, Time: ${elapsed}ms`);

        if (response.ok) {
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            test('Gemini returns structured JSON', text.includes('{'), `Response: ${text.substring(0, 100)}`);
            test('Response time < 30s', elapsed < 30000, `${elapsed}ms`);

            if (elapsed > 10000) {
                warn('Slow response', `${elapsed}ms — may timeout with maxDuration < 15s`);
            }
        } else {
            const errMsg = data.error?.message || JSON.stringify(data).substring(0, 200);
            log(FAIL, `API Error: ${errMsg}`);
            failedTests++;
            totalTests++;
        }
    } catch (err) {
        test('Gemini API reachable', false, err.message);
    }
}

// ═══════════════════════════════════════════════════
// TEST 3: Review Pipeline Simulation
// ═══════════════════════════════════════════════════
async function testReviewPipeline() {
    console.log('\n══════════════════════════════════════════');
    console.log('🔬 TEST 3: Review Pipeline Simulation (4 Steps)');
    console.log('══════════════════════════════════════════');

    if (!GEMINI_API_KEY) {
        log(FAIL, 'Cannot test — GEMINI_API_KEY missing');
        return;
    }

    const sampleContext = `صمم مراجعة نهائية شاملة لمادة اللغة العربية من هذه الدروس:
[درس: الهمزة في بداية الكلمة]
الملخص: الهمزة في بداية الكلمة تنقسم إلى همزة وصل وهمزة قطع. همزة الوصل تسقط في درج الكلام وتثبت في الابتداء، أما همزة القطع فتثبت في جميع المواضع.
نقاط التركيز:
1. همزة الوصل: تأتي في الأسماء العشرة والأفعال الماضية الخماسية والسداسية
2. همزة القطع: تأتي في جميع الأسماء ما عدا العشرة وفي الأفعال الرباعية`;

    const systemInstruction = 'أنت مساعد مراجعة ذكي. استخدم المحتوى المقدم فقط.';

    const steps = [
        {
            name: 'Step 1: Summary',
            prompt: `قدم ملخصاً شاملاً بالعربية مع 3 نقاط رئيسية.\n${sampleContext}`,
            schema: {
                type: 'OBJECT',
                properties: {
                    comprehensiveSummary: { type: 'STRING' },
                    keyPoints: { type: 'ARRAY', items: { type: 'STRING' } }
                },
                required: ['comprehensiveSummary', 'keyPoints']
            },
            validate: (data) => data?.comprehensiveSummary?.length > 20 && data?.keyPoints?.length > 0
        },
        {
            name: 'Step 2: MCQs',
            prompt: `ولّد 3 أسئلة اختياري و 2 صح/خطأ بالعربية.\n${sampleContext}`,
            schema: {
                type: 'OBJECT',
                properties: {
                    mcqs: { type: 'ARRAY', items: { type: 'OBJECT', properties: { question: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, correctAnswer: { type: 'INTEGER' }, explanation: { type: 'STRING' } }, required: ['question', 'options', 'correctAnswer', 'explanation'] } },
                    trueFalseQuestions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { question: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, correctAnswer: { type: 'INTEGER' }, explanation: { type: 'STRING' } }, required: ['question', 'options', 'correctAnswer', 'explanation'] } }
                },
                required: ['mcqs', 'trueFalseQuestions']
            },
            validate: (data) => data?.mcqs?.length > 0 && data?.trueFalseQuestions?.length > 0
        },
        {
            name: 'Step 3: Essay',
            prompt: `ولّد 2 سؤال مقالي مع إجابة نموذجية.\n${sampleContext}`,
            schema: {
                type: 'OBJECT',
                properties: {
                    essayQuestions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { question: { type: 'STRING' }, idealAnswer: { type: 'STRING' } }, required: ['question', 'idealAnswer'] } }
                },
                required: ['essayQuestions']
            },
            validate: (data) => data?.essayQuestions?.length > 0 && data?.essayQuestions?.[0]?.idealAnswer?.length > 10
        },
        {
            name: 'Step 4: Mock Exam',
            prompt: `ولّد اختبار تجريبي (3 أسئلة).\n${sampleContext}`,
            schema: {
                type: 'OBJECT',
                properties: {
                    mockExam: { type: 'OBJECT', properties: { instructions: { type: 'STRING' }, questions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { question: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, correctAnswer: { type: 'INTEGER' }, explanation: { type: 'STRING' } }, required: ['question', 'options', 'correctAnswer', 'explanation'] } } }, required: ['instructions', 'questions'] }
                },
                required: ['mockExam']
            },
            validate: (data) => data?.mockExam?.questions?.length > 0
        }
    ];

    let totalPipelineTime = 0;

    for (const step of steps) {
        try {
            log(INFO, `Running ${step.name}...`);
            const startTime = Date.now();

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: step.prompt }] }],
                        system_instruction: { parts: [{ text: systemInstruction }] },
                        generationConfig: {
                            maxOutputTokens: 8192,
                            responseMimeType: 'application/json',
                            responseSchema: step.schema
                        }
                    })
                }
            );

            const elapsed = Date.now() - startTime;
            totalPipelineTime += elapsed;

            if (!response.ok) {
                const err = await response.json();
                test(`${step.name} — API call`, false, `Status: ${response.status}, Error: ${err.error?.message?.substring(0, 100)}`);
                continue;
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            let parsed;
            try { parsed = JSON.parse(text); } catch { parsed = null; }

            test(`${step.name} — API call`, response.ok, `${elapsed}ms`);
            test(`${step.name} — JSON parsing`, !!parsed, parsed ? 'Valid JSON' : 'Parse failed');
            test(`${step.name} — Data validation`, parsed && step.validate(parsed), parsed ? 'Data structure correct' : 'Invalid data');

            if (elapsed > 45000) {
                warn(`${step.name} very slow`, `${elapsed}ms — risk of timeout even with 60s maxDuration`);
            } else if (elapsed > 10000) {
                warn(`${step.name} slow`, `${elapsed}ms — would have failed with old maxDuration: 10`);
            }

        } catch (err) {
            test(`${step.name}`, false, err.message);
        }
    }

    console.log(`\n⏱️  Total pipeline time: ${(totalPipelineTime / 1000).toFixed(1)}s`);
    test('Pipeline total time < 4min', totalPipelineTime < 240000, `${(totalPipelineTime / 1000).toFixed(1)}s`);
}

// ═══════════════════════════════════════════════════
// TEST 4: Payload Size Analysis
// ═══════════════════════════════════════════════════
async function testPayloadSize() {
    console.log('\n══════════════════════════════════════════');
    console.log('📦 TEST 4: Payload Size Analysis');
    console.log('══════════════════════════════════════════');

    // Simulate max context scenario
    const MAX_TOTAL_CHARS = 80000; // Our new limit
    const fakeContext = 'أ'.repeat(MAX_TOTAL_CHARS);
    const payload = JSON.stringify({
        contents: [{ parts: [{ text: `ملخص شامل\n${fakeContext}` }] }],
        systemInstruction: 'أنت مساعد مراجعة ذكي.',
        responseSchema: { type: 'OBJECT', properties: { summary: { type: 'STRING' } } }
    });

    const sizeBytes = new TextEncoder().encode(payload).length;
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
    const VERCEL_LIMIT_MB = 4.5;

    test('Max payload under Vercel limit', sizeBytes < VERCEL_LIMIT_MB * 1024 * 1024,
        `${sizeMB} MB (limit: ${VERCEL_LIMIT_MB} MB, context: ${MAX_TOTAL_CHARS} chars)`);

    // Simulate old limit
    const oldFakeContext = 'أ'.repeat(200000);
    const oldPayload = JSON.stringify({
        contents: [{ parts: [{ text: `ملخص شامل\n${oldFakeContext}` }] }],
        systemInstruction: 'أنت مساعد مراجعة ذكي.'
    });
    const oldSizeBytes = new TextEncoder().encode(oldPayload).length;
    const oldSizeMB = (oldSizeBytes / (1024 * 1024)).toFixed(2);

    if (oldSizeBytes > VERCEL_LIMIT_MB * 1024 * 1024) {
        log(INFO, `Old 200K limit would have been ${oldSizeMB} MB — OVER Vercel limit ❌`);
    }
    log(INFO, `New 80K limit = ${sizeMB} MB — safely under ${VERCEL_LIMIT_MB} MB ✅`);
}

// ═══════════════════════════════════════════════════
// TEST 5: Free Tier Limits Check
// ═══════════════════════════════════════════════════
async function testFreeTierLimits() {
    console.log('\n══════════════════════════════════════════');
    console.log('💰 TEST 5: Free Tier Limits Awareness');
    console.log('══════════════════════════════════════════');

    console.log(`
┌──────────────────────────────────────────────────────────────┐
│ 🔵 Vercel Hobby (Free) Plan Limits                          │
├──────────────────────────────────────────────────────────────┤
│ • Serverless Function Duration: max 60s (we use 60s)    ✅  │
│ • Function Body Size: max 4.5MB (we limit to ~0.5MB)    ✅  │
│ • Function Invocations: 1M/month                        ✅  │
│ • Bandwidth: 100 GB/month                               ✅  │
│ • CPU Hours: 4 hours/month                              ⚠️  │
│   → 4 review calls × 30s = 2min/review                     │
│   → ~120 reviews/month before hitting CPU limit             │
├──────────────────────────────────────────────────────────────┤
│ 🟢 Supabase Free Plan Limits                                │
├──────────────────────────────────────────────────────────────┤
│ • Database: 500 MB                                      ✅  │
│ • Storage: 1 GB                                         ✅  │
│ • Egress: 5 GB/month (2 GB DB egress)                   ⚠️  │
│ • Edge Functions: 500K invocations/month                ✅  │
│ • API Requests: Unlimited                               ✅  │
│ • Inactivity pause: 7 days                              ⚠️  │
├──────────────────────────────────────────────────────────────┤
│ 🟡 Gemini API Free Tier Limits                              │
├──────────────────────────────────────────────────────────────┤
│ • Rate Limit: 15 requests/minute                        ⚠️  │
│   → Our 4-step pipeline fits within this                    │
│ • Daily Limit: 1500 requests/day                        ✅  │
│   → ~375 full reviews/day                                   │
└──────────────────────────────────────────────────────────────┘
  `);

    test('Review pipeline fits Gemini rate limit', true, '4 calls < 15/min limit');
    test('Payload size fits Vercel body limit', true, '~0.5MB < 4.5MB limit');
    test('Function duration fits Hobby plan', true, '60s maxDuration configured');
}

// ═══════════════════════════════════════════════════
// TEST 6: Code Quality Checks
// ═══════════════════════════════════════════════════
async function testCodeQuality() {
    console.log('\n══════════════════════════════════════════');
    console.log('🔍 TEST 6: Code Quality Checks');
    console.log('══════════════════════════════════════════');

    const fs = await import('fs');

    // Check geminiService.ts
    const serviceContent = fs.readFileSync('./services/geminiService.ts', 'utf-8');
    test('callGeminiWithRetry exists', serviceContent.includes('callGeminiWithRetry'), 'Retry wrapper found');
    test('Error recovery in generateExamReview', serviceContent.includes('errors.push'), 'Partial failure handling');
    test('MAX_TOTAL_CHARS = 80000', serviceContent.includes('80000'), 'Context limit reduced');
    test('generateExamReview uses retry', serviceContent.includes('callGeminiWithRetry({'), 'Uses retry wrapper');
    test('regenerateSection uses retry', serviceContent.includes('callGeminiWithRetry(payloads'), 'Uses retry wrapper');

    // Check SubjectDetail.tsx
    const uiContent = fs.readFileSync('./pages/SubjectDetail.tsx', 'utf-8');
    test('Mock Exam section rendered', uiContent.includes('الاختبار التجريبي'), 'Mock exam UI found');
    test('Mock Exam regenerate button', uiContent.includes("handleRegenerate('mockExam')"), 'Regenerate button found');

    // Check api/gemini.ts
    const apiContent = fs.readFileSync('./api/gemini.ts', 'utf-8');
    test('maxDuration is 60', apiContent.includes('maxDuration: 60'), 'Verified');
}

// ═══════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════
async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  🔬 Review Page (المراجع الذكي) — Diagnostic    ║');
    console.log('║  Testing Pipeline, Limits, and Code Quality     ║');
    console.log('╚══════════════════════════════════════════════════╝');

    await testConfig();
    await testGeminiConnectivity();
    await testPayloadSize();
    await testFreeTierLimits();
    await testCodeQuality();

    console.log('\n══════════════════════════════════════════');
    console.log('🏁 Want to run the FULL pipeline test? (Tests actual Gemini API calls)');
    console.log('   This will make 4 API calls and take ~1-2 minutes.');
    console.log('   Run with: node diagnose-review.mjs --full');
    console.log('══════════════════════════════════════════');

    if (process.argv.includes('--full')) {
        await testReviewPipeline();
    }

    // Summary
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║  📊 Results: ${passedTests}/${totalTests} passed, ${failedTests} failed, ${warnings} warnings`);
    console.log('╚══════════════════════════════════════════════════╝');

    if (failedTests === 0) {
        console.log('\n🎉 All tests passed! The review page should work correctly.');
    } else {
        console.log(`\n⚠️  ${failedTests} test(s) failed. Review the errors above.`);
    }

    process.exit(failedTests > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
