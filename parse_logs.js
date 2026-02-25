const fs = require('fs');
const data = JSON.parse(fs.readFileSync('d:/mudhakara-ai-platform-main/mudhakara-ai-platform-main/mudhakara-ai-lastversion.-log-export-2026-02-25T21-18-03.json', 'utf8'));
const filtered = data.filter(e => e.message && e.message.length > 5);
const lines = filtered.map((e, i) => {
    const t = e.timestamp || e.TimeUTC || e.time || '?';
    const fn = e.function_name || '';
    const msg = e.message.replace(/[\r\n]+/g, ' ').substring(0, 250);
    return `${t} | ${fn} | ${msg}`;
});
fs.writeFileSync('d:/mudhakara-ai-platform-main/mudhakara-ai-platform-main/parsed_logs.txt', lines.join('\n'), 'utf8');
console.log(`Wrote ${lines.length} lines to parsed_logs.txt`);
