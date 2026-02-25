import { readFileSync, writeFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/mudhakara-ai-platform-main/mudhakara-ai-platform-main/mudhakara-ai-lastversion.-log-export-2026-02-25T22-25-57.json', 'utf8'));

const filtered = data.filter(e => e.message && e.message.length > 5);
const lines = filtered.map((e, i) => {
    const t = e.timestamp || '?';
    const fn = e.function_name || '';
    const msg = e.message.replace(/[\r\n]+/g, ' ').substring(0, 400);
    return `[${i}] ${t} | ${fn} | ${msg}`;
});

writeFileSync('d:/mudhakara-ai-platform-main/mudhakara-ai-platform-main/parsed_logs3.txt', lines.join('\n'), 'utf8');
console.log(`Wrote ${lines.length} lines to parsed_logs3.txt`);

// Show errors and important messages
console.log('\n=== ERRORS & KEY EVENTS ===');
for (const e of filtered) {
    const m = e.message;
    if (m.includes('Error') || m.includes('error') || m.includes('fail') || m.includes('❌') ||
        m.includes('504') || m.includes('timeout') || m.includes('Orchestrat') ||
        m.includes('[Ingest]') || m.includes('[Analyze]') || m.includes('Content:')) {
        console.log((e.timestamp || '?') + ' | ' + m.replace(/[\r\n]+/g, ' ').substring(0, 350));
    }
}
