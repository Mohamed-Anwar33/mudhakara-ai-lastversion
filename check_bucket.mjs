import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function checkAndCreateBucket() {
    console.log("Checking storage buckets...");
    const { data: buckets, error: bErr } = await supabase.storage.listBuckets();

    if (bErr) {
        console.error("Error listing buckets:", bErr);
        return;
    }

    console.log("Existing buckets:", buckets.map(b => b.name));

    if (!buckets.find(b => b.name === 'ocr')) {
        console.log("Bucket 'ocr' not found. Creating it...");
        const { data, error } = await supabase.storage.createBucket('ocr', {
            public: false,
            allowedMimeTypes: ['text/plain'],
            fileSizeLimit: 10485760 // 10MB
        });
        if (error) {
            console.error("Error creating bucket 'ocr':", error);
        } else {
            console.log("Bucket 'ocr' created successfully!");
        }
    } else {
        console.log("Bucket 'ocr' already exists.");
    }
}

checkAndCreateBucket();
