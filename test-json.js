const raw = `{
  "chapters": [
    {
      "title": "الفصل الأول",
      "summary": "شرح طويل جدا..."
    },
    {
      "title": "الفصل الثاني",
      "summary": "شرح ط`;

function repairTruncatedJSON(raw) {
    try { return JSON.parse(raw); } catch { }

    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) try { return JSON.parse(m[1].trim()); } catch { }

    let fixed = raw.trim();
    fixed = fixed.replace(/,?\s*"[^"]*$/, '');
    fixed = fixed.replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');
    fixed = fixed.replace(/,?\s*"[^"]*":\s*$/, '');
    fixed = fixed.replace(/,\s*$/, '');

    let openBraces = 0, openBrackets = 0, inString = false, escape = false;
    for (const ch of fixed) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
    }
    if (inString) fixed += '"';
    for (let i = 0; i < openBrackets; i++) fixed += ']';
    for (let i = 0; i < openBraces; i++) fixed += '}';

    console.log('--- FIXED STRING ---');
    console.log(fixed);

    try { return JSON.parse(fixed); } catch (e) { console.error('PARSE FAILED:', e.message); return null; }
}

const res = repairTruncatedJSON(raw);
console.log('Result:', JSON.stringify(res, null, 2));
