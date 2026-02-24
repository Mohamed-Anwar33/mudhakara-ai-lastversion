const fs = require('fs');
const logs = JSON.parse(fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-24T20-38-23.json', 'utf8'));
const parseLogs = logs.filter(l => l.message && l.message.includes('[ParsePDF]'));
console.log('Total [ParsePDF] logs:', parseLogs.length);
parseLogs.slice(0, 15).forEach(e => console.log(`[${e.TimeUTC}] ${e.message}`));
