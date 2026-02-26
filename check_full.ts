import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

async function main() {
    // All jobs with ALL details
    const { data: jobs } = await supabase.from('processing_queue')
        .select('id, job_type, status, stage, created_at, completed_at, error_message')
        .eq('lesson_id', lessonId)
        .order('created_at', { ascending: true });

    console.log(`Total jobs: ${jobs?.length}`);
    jobs?.forEach((j: any) => {
        const lecId = j.payload?.lecture_id || '';
        console.log(`[${j.status}] ${j.job_type} | stage: ${j.stage} | created: ${j.created_at} | completed: ${j.completed_at} | err: ${j.error_message || 'none'}`);
    });

    // Check how many distinct lecture_ids have analyze_lecture jobs
    const { data: analyzeLectureJobs } = await supabase.from('processing_queue')
        .select('id, payload')
        .eq('lesson_id', lessonId)
        .eq('job_type', 'analyze_lecture');

    console.log(`\nanalyze_lecture jobs: ${analyzeLectureJobs?.length}`);
    analyzeLectureJobs?.forEach((j: any) => {
        console.log(`  lecture_id: ${j.payload?.lecture_id}`);
    });

    // How many ocr_range jobs?
    const { data: ocrJobs } = await supabase.from('processing_queue')
        .select('id, payload')
        .eq('lesson_id', lessonId)
        .eq('job_type', 'ocr_range');

    console.log(`\nocr_range jobs: ${ocrJobs?.length}`);

    // How many chunk_lecture jobs?
    const { data: chunkJobs } = await supabase.from('processing_queue')
        .select('id, payload')
        .eq('lesson_id', lessonId)
        .eq('job_type', 'chunk_lecture');

    console.log(`chunk_lecture jobs: ${chunkJobs?.length}`);

    // Check the lesson status
    const { data: lesson } = await supabase.from('lessons')
        .select('analysis_status, analysis_result')
        .eq('id', lessonId)
        .single();

    console.log(`\nLesson status: ${lesson?.analysis_status}`);
    console.log(`analysis_result is null?: ${lesson?.analysis_result === null}`);
}

main().catch(console.error);
