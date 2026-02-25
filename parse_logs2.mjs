import { readFileSync, writeFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/mudhakara-ai-platform-main/mudhakara-ai-platform-main/mudhakara-ai-lastversion.-log-export-2026-02-25T21-42-17.json', 'utf8'));

const filtered = data.filter(e => e.message && e.message.length > 5);
const lines = filtered.map((e, i) => {
    const t = e.timestamp || '?';
    const fn = e.function_name || '';
    const msg = e.message.replace(/[\r\n]+/g, ' ').substring(0, 400);
    return `[${i}] ${t} | ${fn} | ${msg}`;
});

writeFileSync('d:/mudhakara-ai-platform-main/mudhakara-ai-platform-main/parsed_logs2.txt', lines.join('\n'), 'utf8');
console.log(`Wrote ${lines.length} lines to parsed_logs2.txt`);

// Also show unique job types and their statuses
const jobStatuses = new Map();
for (const e of filtered) {
    const matches = e.message.matchAll(/(\w+)=(pending|processing|completed|failed)\(([^)]*)\)/g);
    for (const m of matches) {
        jobStatuses.set(m[1], `${m[2]}(${m[3]})`);
    }
}
console.log('\n=== Final Job Statuses ===');
for (const [job, status] of jobStatuses) {
    console.log(`  ${job}: ${status}`);
}

// Show Edge Function calls
console.log('\n=== Edge Function Calls ===');
for (const e of filtered) {
    if (e.message.includes('Orchestrat') || e.message.includes('Edge Function') || e.message.includes('analyze-lesson') || e.message.includes('[Analysis]') || e.message.includes('[Ingest')) {
        console.log(e.message.replace(/[\r\n]+/g, ' ').substring(0, 300));
    }
}
