/**
 * Reset the stuck transcribe_audio job so it retries with Whisper
 * Run AFTER deploying the updated audio-worker
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
    console.log('=== Resetting stuck audio job ===\n');

    // Find and reset the stuck transcribe_audio job
    const { data: jobs } = await supabase
        .from('processing_queue')
        .select('id, status, attempt_count, lesson_id, payload, error_message')
        .eq('job_type', 'transcribe_audio')
        .in('status', ['pending', 'processing', 'failed'])
        .order('created_at', { ascending: false })
        .limit(5);

    if (!jobs || jobs.length === 0) {
        console.log('No stuck audio jobs found.');
        return;
    }

    for (const job of jobs) {
        console.log(`Job ${job.id} | status: ${job.status} | attempts: ${job.attempt_count} | lesson: ${job.lesson_id}`);
        console.log(`  stage: ${job.payload?.stage || 'upload'} | error: ${job.error_message?.substring(0, 80) || 'none'}`);

        // Reset to stage=upload (so it uses Whisper), clear Gemini state, reset attempts
        const { error } = await supabase.from('processing_queue').update({
            status: 'pending',
            attempt_count: 0,
            locked_by: null,
            locked_at: null,
            next_retry_at: null,
            error_message: null,
            payload: {
                ...job.payload,
                stage: 'upload',  // Reset to upload stage (Whisper path)
                gemini_file_uri: undefined,
                gemini_file_name: undefined,
                gemini_mime_type: undefined,
                poll_count: undefined,
            }
        }).eq('id', job.id);

        if (error) {
            console.log(`  ❌ Reset failed: ${error.message}`);
        } else {
            console.log(`  ✅ Reset to pending (stage=upload, attempts=0)`);
        }
    }

    // Also clean up old data for this lesson
    if (jobs[0]) {
        const lessonId = jobs[0].lesson_id;
        console.log(`\n🧹 Cleaning old data for lesson ${lessonId}...`);

        // Delete old (hallucinated) transcript
        for (const path of [
            `${lessonId}/raw_transcript.txt`,
            `audio_transcripts/${lessonId}/raw_transcript.txt`,
        ]) {
            await supabase.storage.from('audio_transcripts').remove([path]);
        }
        console.log('  ✅ Deleted old transcript');

        // Delete old segments and analysis
        await supabase.from('segmented_lectures').delete().eq('lesson_id', lessonId);
        console.log('  ✅ Deleted old segments');

        // Reset ALL downstream jobs (segment, analyze, quiz, finalize)
        const { data: downstreamJobs } = await supabase
            .from('processing_queue')
            .select('id, job_type, status')
            .eq('lesson_id', lessonId)
            .in('job_type', ['segment_lesson', 'analyze_lecture', 'generate_quiz', 'finalize_global_summary']);

        if (downstreamJobs) {
            for (const dj of downstreamJobs) {
                if (['analyze_lecture', 'generate_quiz', 'finalize_global_summary'].includes(dj.job_type)) {
                    await supabase.from('processing_queue').delete().eq('id', dj.id);
                    console.log(`  🗑️ Deleted ${dj.job_type} job ${dj.id}`);
                } else {
                    await supabase.from('processing_queue').update({
                        status: 'pending', attempt_count: 0,
                        locked_by: null, locked_at: null,
                        next_retry_at: null, error_message: null
                    }).eq('id', dj.id);
                    console.log(`  ✅ Reset ${dj.job_type} ${dj.id} to pending`);
                }
            }
        }

        // Reset lesson analysis status
        await supabase.from('lessons').update({
            analysis_status: 'processing', analysis_result: null
        }).eq('id', lessonId);
        console.log('  ✅ Reset lesson analysis status');
    }

    console.log('\n✅ Done! Pipeline will re-process with hallucination detection.');
}

main().catch(e => console.error('FATAL:', e));
