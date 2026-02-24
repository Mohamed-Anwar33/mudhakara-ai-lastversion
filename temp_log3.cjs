const fs = require('fs');
const logs = JSON.parse(fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-24T20-38-23.json', 'utf8'));

const extractLogs = logs.filter(l => l.message && l.message.includes('extract_text_range'));
console.log('Total extract_text_range mentions:', extractLogs.length);
extractLogs.slice(0, 5).forEach(e => console.log(`[${e.TimeUTC}] ${e.message}`));

const errLogs = logs.filter(l => l.responseStatusCode === 500 || (l.message && (l.message.includes('Error') || l.message.includes('Failed') || l.message.includes('failed'))));
console.log('\n--- Errors ---');
errLogs.slice(0, 10).forEach(e => console.log(`[${e.TimeUTC}] [${e.responseStatusCode || 'N/A'}] ${e.message}`));
