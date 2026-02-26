const fs = require('fs');

const rawData = fs.readFileSync('mudhakara-ai-lastversion.-log-export-2026-02-26T15-23-23.json', 'utf8');
const logs = JSON.parse(rawData);

// Sort by timestamp
logs.sort((a, b) => a.timestampInMs - b.timestampInMs);

const relevantLogs = logs.filter(log => {
    if (!log) return false;
    const msg = (log.message || '').toLowerCase();

    return true; // Just get all the logs to see the sequence
});

// To avoid massive file, let's just map to essential fields
const mappedLogs = relevantLogs.map(log => ({
    time: log.TimeUTC,
    status: log.responseStatusCode,
    path: log.requestPath,
    message: log.message
}));

fs.writeFileSync('sequence_logs.json', JSON.stringify(mappedLogs, null, 2));
console.log(`Wrote ${mappedLogs.length} logs.`);
