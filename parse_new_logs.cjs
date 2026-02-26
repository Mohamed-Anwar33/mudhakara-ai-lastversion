const fs = require('fs');

const rawData = fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-26T17-16-38.json', 'utf8');
const logs = JSON.parse(rawData);

// Sort by timestamp
logs.sort((a, b) => {
    const ta = new Date(a.timestamp || a.time || 0).getTime();
    const tb = new Date(b.timestamp || b.time || 0).getTime();
    return ta - tb;
});

// Show EVERY log's full message, sorted
const allMsgs = logs.map((log, i) => {
    const time = log.timestamp || log.time || '?';
    const status = log.proxy?.statusCode || log.status_code || '';
    const path = log.proxy?.path || log.path || log.requestPath || '';
    const msg = log.message || '';
    const level = log.level || '';
    return `[${i}] ${level} | ${status} | ${path}\n    ${msg.substring(0, 500)}`;
}).join('\n\n');

fs.writeFileSync('all_logs_readable.txt', allMsgs, 'utf8');
console.log(`Written ${logs.length} entries to all_logs_readable.txt`);
