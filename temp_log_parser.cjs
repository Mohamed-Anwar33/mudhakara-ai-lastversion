const fs = require('fs');
const logs = JSON.parse(fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-24T20-38-23.json', 'utf8'));

const processQueueLogs = logs.filter(l => l.requestPath && l.requestPath.includes('/api/process-queue'));
console.log('--- Process Queue Requests ---');
console.log('Total /api/process-queue requests:', processQueueLogs.length);

const jobStatusLogs = logs.filter(l => l.requestPath && l.requestPath.includes('/api/job-status'));
console.log('\n--- Job Status Requests ---');
console.log('Total /api/job-status requests:', jobStatusLogs.length);

const errors = logs.filter(l =>
    (l.responseStatusCode >= 400) ||
    (l.message && (l.message.toLowerCase().includes('error') || l.message.toLowerCase().includes('fail') || l.message.toLowerCase().includes('timeout')))
);
console.log('\n--- Errors/Anomalies ---');
errors.slice(0, 50).forEach(e => console.log(`[${e.TimeUTC}] [${e.responseStatusCode || 'N/A'}] ${e.requestPath || e.function || e.proxy?.clientIp} - ${e.message}`));

const ingestLogs = logs.filter(l => l.function && l.function.includes('ingest-file'));
console.log('\n--- Ingest File Execution Logs ---');
ingestLogs.slice(0, 10).forEach(e => console.log(`[${e.TimeUTC}] ${e.message}`));
