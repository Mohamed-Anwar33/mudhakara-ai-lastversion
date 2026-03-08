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

    // Also reset any stuck segment_lesson jobs for the same lesson
    if (jobs[0]) {
        const lessonId = jobs[0].lesson_id;
        const { data: segJobs } = await supabase
            .from('processing_queue')
            .select('id, status')
            .eq('lesson_id', lessonId)
            .eq('job_type', 'segment_lesson')
            .in('status', ['pending', 'processing', 'failed']);

        if (segJobs && segJobs.length > 0) {
            for (const sj of segJobs) {
                await supabase.from('processing_queue').update({
                    status: 'pending',
                    attempt_count: 0,
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: null,
                    error_message: null
                }).eq('id', sj.id);
                console.log(`  ✅ Reset segment_lesson ${sj.id} to pending`);
            }
        }
    }

    console.log('\nDone! After deploying audio-worker, the job will be picked up and use Whisper.');
}

main().catch(e => console.error('FATAL:', e));
