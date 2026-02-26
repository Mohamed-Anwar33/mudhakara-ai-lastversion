const fs = require('fs');

const rawData = fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-26T15-23-23.json', 'utf8');
const logs = JSON.parse(rawData);

const errors = logs.filter(log => {
    if (!log) return false;
    const msg = (log.message || '').toLowerCase();
    const level = (log.level || '').toLowerCase();

    return level === 'error' ||
        msg.includes('error') ||
        msg.includes('fail') ||
        msg.includes('exception') ||
        msg.includes('خطأ');
});

fs.writeFileSync('errors_only.json', JSON.stringify(errors, null, 2));
console.log(`Found ${errors.length} error logs.`);
