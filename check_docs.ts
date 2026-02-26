import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const lessonId = 'c8989bcb-8858-4ea5-b0d8-4bdd48398b89';

async function main() {
    const { count } = await supabase.from('document_sections').select('id', { count: 'exact', head: true }).eq('lesson_id', lessonId);
    console.log(`Document sections count: ${count}`);
}

main().catch(console.error);
