import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const s = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
    // Get the active processing lesson
    const { data: lessons } = await s.from('lessons')
        .select('id, lesson_title, analysis_status, pipeline_stage, sources')
        .order('created_at', { ascending: false }).limit(3);

    for (const lesson of (lessons || [])) {
        const lid = lesson.id;
        if (lesson.analysis_status !== 'processing' && lesson.analysis_status !== 'completed') continue;

        console.log('\n========================================');
        console.log('Lesson:', lid.substring(0, 8), '|', lesson.analysis_status);

        // Get ALL segments
        const { data: segs } = await s.from('segmented_lectures')
            .select('id, title, status, char_count, start_page, end_page')
            .eq('lesson_id', lid).order('start_page');

        if (!segs || segs.length === 0) { console.log('  No segments'); continue; }

        // Count weak ones (char_count = 0)
        const weakSegs = segs.filter(seg => !seg.char_count || seg.char_count === 0);
        const strongSegs = segs.filter(seg => seg.char_count && seg.char_count > 0);

        console.log(`  Total segments: ${segs.length} | With content: ${strongSegs.length} | Empty (char_count=0): ${weakSegs.length}`);

        // Check: for weak segments, is there an analysis file?
        console.log('\n  --- Weak Segments Analysis ---');
        let emptyAnalysis = 0;
        let hasAnalysis = 0;
        for (const seg of weakSegs.slice(0, 5)) {
            const storagePath = `${lid}/lecture_${seg.id}.json`;
            try {
                const { data: blob } = await s.storage.from('analysis').download(storagePath);
                if (blob) {
                    const json = JSON.parse(await blob.text());
                    const expLen = (json.explanation_notes || '').length;
                    const fpLen = (json.focusPoints || []).length;
                    const quizLen = (json.quizzes || []).length;
                    if (expLen > 100) {
                        hasAnalysis++;
                        console.log(`  ✅ ${seg.title?.substring(0, 40)} | exp:${expLen} fp:${fpLen} quiz:${quizLen}`);
                    } else {
                        emptyAnalysis++;
                        console.log(`  ❌ ${seg.title?.substring(0, 40)} | exp:${expLen} fp:${fpLen} quiz:${quizLen} — EMPTY!`);
                    }
                } else {
                    emptyAnalysis++;
                    console.log(`  ❌ ${seg.title?.substring(0, 40)} | NO analysis file`);
                }
            } catch (e: any) {
                emptyAnalysis++;
                console.log(`  ❌ ${seg.title?.substring(0, 40)} | Error: ${e.message}`);
            }
        }
        console.log(`  Summary: ${hasAnalysis} have analysis, ${emptyAnalysis} are empty`);

        // Check: what does lesson_pages look like for these page ranges?
        console.log('\n  --- Pages for Weak Segments ---');
        for (const seg of weakSegs.slice(0, 3)) {
            const { data: pages } = await s.from('lesson_pages')
                .select('page_number, storage_path, char_count, status')
                .eq('lesson_id', lid)
                .gte('page_number', seg.start_page)
                .lte('page_number', seg.end_page);

            const totalChars = (pages || []).reduce((sum, p) => sum + (p.char_count || 0), 0);
            console.log(`  Pages ${seg.start_page}-${seg.end_page}: ${pages?.length || 0} pages, ${totalChars} total chars`);
            if (pages && pages.length > 0) {
                for (const p of pages.slice(0, 3)) {
                    console.log(`    p${p.page_number}: ${p.char_count || 0} chars | ${p.status} | ${p.storage_path || 'NO PATH'}`);
                }
            }
        }

        // Check: what does the title matching look like?
        console.log('\n  --- Title Matching Test ---');
        // Simulate what handleReanalyzeAllWeak does
        const { data: localStorageKey } = await s.from('lessons')
            .select('id').eq('course_id', lesson.sources?.[0]?.course_id).limit(1);

        // Show first few segment titles vs what the UI might show (from analysis files)
        console.log('  First 5 segment titles:');
        for (const seg of segs.slice(0, 5)) {
            console.log(`    "${seg.title?.substring(0, 60)}" (${seg.char_count || 0} chars)`);
        }
    }
}

main().catch(e => console.error('FATAL:', e));
