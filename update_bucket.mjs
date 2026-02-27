import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function updateBucket() {
    console.log("Updating ocr bucket...");
    const { data, error } = await supabase.storage.updateBucket('ocr', {
        public: false,
        allowedMimeTypes: ['text/plain', 'text/plain;charset=UTF-8'],
        fileSizeLimit: 10485760 // 10MB
    });

    if (error) {
        console.error("Error updating bucket 'ocr':", error);
    } else {
        console.log("Bucket 'ocr' updated successfully!");
    }
}

updateBucket();
