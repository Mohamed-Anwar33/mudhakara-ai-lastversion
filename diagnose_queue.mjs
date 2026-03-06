const SB = 'https://hsabozxfjdeoddlltivw.supabase.co';
const K = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYWJvenhmamRlb2RkbGx0aXZ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU5Mzc2NiwiZXhwIjoyMDg1MTY5NzY2fQ.QEvf3c_rn9K1PzjVJXwELtT2PPzu6OFV7-wjvp2CYF0';
const h = { 'apikey': K, 'Authorization': 'Bearer ' + K, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

async function main() {
    // 1. Kill stuck segment_lesson with 142+ attempts
    console.log('=== FIX 1: Kill stuck segment_lesson (>10 attempts) ===');
    const r1 = await fetch(SB + '/rest/v1/processing_queue?job_type=eq.segment_lesson&attempt_count=gt.10&status=in.(pending,processing)', {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ status: 'failed', error_message: 'Auto-killed: exceeded 10 attempts', locked_by: null, locked_at: null })
    });
    const fixed1 = await r1.json();
    console.log('  Killed ' + fixed1.length + ' stuck segment_lesson jobs');

    // 2. Kill any other jobs with >20 attempts (they're clearly broken)
    console.log('\n=== FIX 2: Kill any jobs with >20 attempts ===');
    const r2 = await fetch(SB + '/rest/v1/processing_queue?attempt_count=gt.20&status=in.(pending,processing)', {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ status: 'failed', error_message: 'Auto-killed: exceeded 20 attempts', locked_by: null, locked_at: null })
    });
    const fixed2 = await r2.json();
    console.log('  Killed ' + fixed2.length + ' stuck jobs');

    // 3. Re-check remaining active jobs
    console.log('\n=== REMAINING ACTIVE JOBS ===');
    const r3 = await fetch(SB + '/rest/v1/processing_queue?status=in.(pending,processing)&select=id,lesson_id,job_type,status,attempt_count&order=created_at&limit=50', {
        headers: { 'apikey': K, 'Authorization': 'Bearer ' + K }
    });
    const remaining = await r3.json();
    console.log('  Total active: ' + remaining.length);
    for (const j of remaining) {
        console.log('  [' + j.status + '] ' + j.job_type + ' | lesson:' + j.lesson_id.slice(0, 8) + ' | attempts:' + j.attempt_count);
    }
}

main().catch(console.error);
