import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function createAnalysisBucket() {
    console.log("Checking storage buckets for 'analysis'...");
    const { data: buckets, error: bErr } = await supabase.storage.listBuckets();

    if (bErr) {
        console.error("Error listing buckets:", bErr);
        return;
    }

    if (!buckets.find(b => b.name === 'analysis')) {
        console.log("Bucket 'analysis' not found. Creating it...");
        const { data, error } = await supabase.storage.createBucket('analysis', {
            public: false,
            allowedMimeTypes: ['application/json'],
            fileSizeLimit: 10485760 // 10MB
        });
        if (error) {
            console.error("Error creating bucket 'analysis':", error);
        } else {
            console.log("Bucket 'analysis' created successfully!");
        }
    } else {
        console.log("Bucket 'analysis' already exists.");
    }
}

async function resetAnalyzeJobs() {
    const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';
    console.log(`\nResetting failed analyze_lecture jobs for lesson: ${lessonId}`);

    // Reset failed analyze_lecture jobs (they are probably stuck in "processing" state with error_message)
    const { data: updatedQueue, error: uErr } = await supabase
        .from('processing_queue')
        .update({ status: 'pending', locked_by: null, locked_at: null, attempt_count: 0, error_message: null })
        .eq('lesson_id', lessonId)
        .eq('job_type', 'analyze_lecture')
        .neq('status', 'completed');

    if (uErr) {
        console.error("Queue update error:", uErr);
    } else {
        console.log("Reset analyze_lecture jobs.");
    }
}

async function run() {
    await createAnalysisBucket();
    await resetAnalyzeJobs();
}

run();
