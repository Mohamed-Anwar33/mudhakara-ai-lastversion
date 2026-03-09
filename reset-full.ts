/**
 * Full reset for a lesson — deletes ALL analysis data and re-triggers from scratch
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
    const LESSON_ID = '30054b02-a0cd-4fcc-b851-ac7f1c7b49b7';
    console.log(`\n🔄 FULL RESET for lesson ${LESSON_ID}\n`);

    // 1. Delete all queue jobs
    const { data: jobs } = await supabase.from('processing_queue')
        .select('id, job_type, status')
        .eq('lesson_id', LESSON_ID);

    if (jobs && jobs.length > 0) {
        await supabase.from('processing_queue').delete().eq('lesson_id', LESSON_ID);
        console.log(`🗑️ Deleted ${jobs.length} queue jobs`);
        jobs.forEach(j => console.log(`   ${j.job_type}: ${j.status}`));
    } else {
        console.log('ℹ️ No queue jobs found');
    }

    // 2. Delete segments
    const { count: segCount } = await supabase.from('segmented_lectures')
        .delete({ count: 'exact' }).eq('lesson_id', LESSON_ID);
    console.log(`🗑️ Deleted ${segCount || 0} segments`);

    // 3. Delete old transcripts
    for (const path of [
        `${LESSON_ID}/raw_transcript.txt`,
        `audio_transcripts/${LESSON_ID}/raw_transcript.txt`,
    ]) {
        await supabase.storage.from('audio_transcripts').remove([path]);
    }
    // Delete any chunk files
    const { data: chunkFiles } = await supabase.storage.from('audio_transcripts')
        .list(LESSON_ID);
    if (chunkFiles && chunkFiles.length > 0) {
        const paths = chunkFiles.map(f => `${LESSON_ID}/${f.name}`);
        await supabase.storage.from('audio_transcripts').remove(paths);
        console.log(`🗑️ Deleted ${chunkFiles.length} transcript files`);
    }

    // 4. Delete analysis results
    const { data: analysisList } = await supabase.storage.from('analysis').list(LESSON_ID);
    if (analysisList && analysisList.length > 0) {
        const paths = analysisList.map(f => `${LESSON_ID}/${f.name}`);
        await supabase.storage.from('analysis').remove(paths);
        console.log(`🗑️ Deleted ${analysisList.length} analysis files`);
    }

    // 5. Delete document sections
    const { count: secCount } = await supabase.from('document_sections')
        .delete({ count: 'exact' }).eq('lesson_id', LESSON_ID);
    console.log(`🗑️ Deleted ${secCount || 0} document sections`);

    // 6. Reset lesson status
    await supabase.from('lessons').update({
        analysis_status: null,
        analysis_result: null
    }).eq('id', LESSON_ID);
    console.log('✅ Reset lesson analysis status to null');

    console.log('\n✅ Full reset complete!');
    console.log('📝 Go to the app and click "استخراج من الذاكرة" to re-analyze.');
    console.log('   The new pipeline will:');
    console.log('   1. Transcribe with hallucination detection');
    console.log('   2. Smart topic-based segmentation');
    console.log('   3. Accurate per-topic analysis');
}

main().catch(e => console.error('FATAL:', e));
