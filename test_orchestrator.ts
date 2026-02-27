import 'dotenv/config';
import handler from './api/process-queue.js';
import { createClient } from '@supabase/supabase-js';

// Mock req and res
const req: any = { method: 'POST' };
const res: any = {
    status: (code: number) => ({
        json: (data: any) => {
            console.log(`STATUS: ${code}`, JSON.stringify(data, null, 2));
        }
    })
};

// Polyfill process.env from .env if needed
if (!process.env.VITE_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.VITE_SUPABASE_URL = process.env.SUPABASE_URL;
}

(async () => {
    try {
        console.log("Running orchestrator locally...");
        await handler(req, res);
    } catch (e) {
        console.error("Local crash:", e);
    }
})();
