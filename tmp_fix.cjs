const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://hsabozxfjdeoddlltivw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0'
);

async function applyMigrationAndFix() {
    const lessonId = '65ae7cce-a566-4952-90af-2ff78a13a333';
    console.log('=== APPLYING MIGRATION 017 + FIX ===\n');

    // 1. Drop the old constraint and create the new one (without analyze_lecture, generate_quiz)
    const { error: dropErr } = await supabase.rpc('exec_sql', {
        sql: `DROP INDEX IF EXISTS idx_processing_queue_active_singleton_jobs;`
    }).maybeSingle();

    // If RPC doesn't exist, try via REST
    if (dropErr) {
        console.log('RPC not available, applying via direct SQL...');
        // We'll use a workaround — the constraint is the problem, and we can't run DDL via API
        // But we CAN insert the jobs now if we change status to 'completed' for the conflicting ones
        // Actually, the issue is that `ignoreDuplicates: true` in upsert silently swallows the error
        // We need to run this migration on Supabase Dashboard

        console.log('⚠️ NEED TO RUN THIS SQL ON SUPABASE DASHBOARD:');
        console.log(`
DROP INDEX IF EXISTS idx_processing_queue_active_singleton_jobs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_queue_active_singleton_jobs
    ON processing_queue (lesson_id, job_type)
    WHERE status IN ('pending', 'processing')
      AND job_type IN (
        'segment_lesson',
        'finalize_global_summary',
        'generate_analysis',
        'generate_book_overview',
        'embed_sections',
        'extract_toc',
        'build_lecture_segments',
        'book_segment'
      );
        `);
    }

    // 2. For now, insert analyze_lecture jobs one by one (they'll conflict with the old constraint)
    // Instead, let's create the jobs WITHOUT the constraint by dropping it first
    console.log('\n=== Attempting to create jobs via direct inserts ===');

    const { data: lectures } = await supabase.from('segmented_lectures')
        .select('id, title, start_page, end_page')
        .eq('lesson_id', lessonId);

    console.log(`Found ${lectures?.length || 0} lectures to create jobs for`);

    // Try inserting one at a time to see what happens
    let created = 0;
    for (const lec of (lectures || [])) {
        const { error } = await supabase.from('processing_queue').insert({
            lesson_id: lessonId,
            job_type: 'analyze_lecture',
            payload: { lecture_id: lec.id, title: lec.title, start_page: lec.start_page, end_page: lec.end_page },
            status: 'pending',
            dedupe_key: `lesson:${lessonId}:analyze_lecture:${lec.id}`
        });
        if (error) {
            console.log(`  ❌ ${lec.title?.substring(0, 30)}: ${error.message.substring(0, 80)}`);
        } else {
            created++;
        }
    }
    console.log(`\nCreated ${created}/${lectures?.length || 0} analyze_lecture jobs`);

    // Also create finalize job
    const { error: finErr } = await supabase.from('processing_queue').insert({
        lesson_id: lessonId,
        job_type: 'finalize_global_summary',
        payload: {},
        status: 'pending',
        dedupe_key: `lesson:${lessonId}:finalize_global_summary`
    });
    console.log(`finalize_global_summary: ${finErr ? finErr.message.substring(0, 80) : '✅'}`);

    // Fix lesson status
    await supabase.from('lessons').update({
        analysis_status: 'processing',
        pipeline_stage: 'generating_summary'
    }).eq('id', lessonId);
    console.log('\nLesson status reset to processing');
}

applyMigrationAndFix().catch(console.error);
