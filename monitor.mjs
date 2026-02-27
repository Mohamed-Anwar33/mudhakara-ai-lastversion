import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function monitor() {
    const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

    const { data: q } = await supabase.from('processing_queue').select('job_type, status').eq('lesson_id', lessonId);

    const analyze = q.filter(x => x.job_type === 'analyze_lecture');
    const analyzeDone = analyze.filter(x => x.status === 'completed').length;

    const quiz = q.filter(x => x.job_type === 'generate_quiz');
    const quizDone = quiz.filter(x => x.status === 'completed').length;

    console.log(`\n--- Queue Status ---`);
    console.log(`analyze_lecture: ${analyzeDone} / ${analyze.length} completed`);
    console.log(`generate_quiz:   ${quizDone} / ${quiz.length} completed`);

    const { data: s } = await supabase.from('segmented_lectures').select('status').eq('lesson_id', lessonId);

    const pending = s.filter(x => x.status === 'pending').length;
    const summaryDone = s.filter(x => x.status === 'summary_done').length;
    const quizDoneS = s.filter(x => x.status === 'quiz_done').length;

    console.log(`\n--- Segments Status ---`);
    console.log(`Total Segments: ${s.length}`);
    console.log(`pending:      ${pending}`);
    console.log(`summary_done: ${summaryDone}`);
    console.log(`quiz_done:    ${quizDoneS}`);
}

monitor();
