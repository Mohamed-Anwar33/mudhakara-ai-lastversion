const fs = require('fs');
const logs = JSON.parse(fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-24T19-20-56.json', 'utf8'));
const errors = logs.filter(log => log.level === 'error' || (log.message && log.message.toLowerCase().includes('error')) || (log.message && log.message.toLowerCase().includes('fail')));
errors.forEach(e => console.log(`[${e.TimeUTC}] ${e.function} - ${e.message}`));
if (errors.length === 0) console.log('No direct errors found, printing warnings...');
const warnings = logs.filter(log => log.level === 'warn' || (log.message && log.message.toLowerCase().includes('warn')));
warnings.slice(0, 10).forEach(w => console.log(`[${w.TimeUTC}] ${w.function} - ${w.message}`));
