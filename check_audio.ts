import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
    const { data: lessons } = await sb.from('lessons')
        .select('id').like('lesson_title', '__analysis__%');

    for (const l of (lessons || [])) {
        const { data: segments } = await sb.from('segmented_lectures')
            .select('id, title, start_page, end_page, status, summary_storage_path, char_count')
            .eq('lesson_id', l.id)
            .order('start_page', { ascending: true });

        console.log(`\n=== Lesson ${l.id} — ${segments?.length} segments ===\n`);

        for (const seg of (segments || [])) {
            // Check the analysis JSON content
            let explanationLen = 0;
            let quizCount = 0;
            let focusCount = 0;
            if (seg.summary_storage_path) {
                try {
                    const { data: blob } = await sb.storage.from('analysis').download(seg.summary_storage_path);
                    if (blob) {
                        const parsed = JSON.parse(await blob.text());
                        explanationLen = (parsed.explanation_notes || '').length;
                        quizCount = (parsed.quizzes || []).length;
                        focusCount = (parsed.focusPoints || []).length;
                    }
                } catch (e) { }
            }

            // Check OCR pages quality
            const { data: pages } = await sb.from('lesson_pages')
                .select('page_number, char_count, status')
                .eq('lesson_id', l.id)
                .gte('page_number', seg.start_page)
                .lte('page_number', seg.end_page)
                .order('page_number');

            const totalOcrChars = (pages || []).reduce((sum, p) => sum + (p.char_count || 0), 0);
            const failedPages = (pages || []).filter(p => p.status !== 'success');
            const lowOcrPages = (pages || []).filter(p => (p.char_count || 0) < 50);

            // Determine if this would be "weak"
            const isWeak = explanationLen < 500 && quizCount === 0;

            const statusIcon = isWeak ? '⚠️' : '✅';
            console.log(`${statusIcon} "${seg.title}" (pages ${seg.start_page}-${seg.end_page})`);
            console.log(`   OCR: ${totalOcrChars} chars | Analysis: ${explanationLen} chars | Quizzes: ${quizCount} | Focus: ${focusCount}`);

            if (failedPages.length > 0) {
                console.log(`   ❌ Failed pages: ${failedPages.map(p => `p${p.page_number}(${p.status})`).join(', ')}`);
            }
            if (lowOcrPages.length > 0) {
                console.log(`   ⚠️ Low OCR pages: ${lowOcrPages.map(p => `p${p.page_number}(${p.char_count}ch)`).join(', ')}`);
            }
        }
    }
}

check().catch(console.error);
