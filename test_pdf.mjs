// Script to test Gemini Files API with large PDFs
async function test() {
    const geminiKey = 'AIzaSyCkh2d7nPDa5J3D1Tc6s9sABDoykobeIco';
    console.log('[1] Fetching PDF from Supabase Storage...');
    const res = await fetch('https://hsabozxfjdeoddlltivw.supabase.co/storage/v1/object/public/homework-uploads/1771780787640__________________-________compressed.pdf');
    const buffer = await res.arrayBuffer();
    console.log('[2] PDF Downloaded. Size:', (buffer.byteLength / 1024 / 1024).toFixed(2), 'MB');

    console.log('[3] Starting Gemini Files API upload...');
    const startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiKey}`,
        {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': buffer.byteLength.toString(),
                'X-Goog-Upload-Header-Content-Type': 'application/pdf',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ file: { displayName: 'test.pdf' } })
        }
    );
    if (!startRes.ok) { console.error('Start failed', await startRes.text()); return }
    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    console.log('[4] Got Upload URL. Uploading bytes...');

    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': buffer.byteLength.toString(),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: buffer
    });
    if (!uploadRes.ok) { console.error('Upload failed', await uploadRes.text()); return }
    const fileInfo = await uploadRes.json();
    console.log('[5] Uploaded. File URI:', fileInfo.file?.uri);

    const fileName2 = fileInfo.file?.name;
    console.log('[6] Waiting for ACTIVE state...');
    let startTime = Date.now();
    for (let i = 0; i < 60; i++) {
        const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${geminiKey}`);
        const status = await s.json();
        console.log(' - Status:', status.state, (Date.now() - startTime) / 1000, 'sec');
        if (status.state === 'ACTIVE') break;
        if (status.state === 'FAILED') throw new Error('Failed');
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('[7] Calling generateContent...');
    startTime = Date.now();
    const genRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: 'استخرج النص الكامل من هذا الملف' }, { fileData: { fileUri: fileInfo.file.uri, mimeType: 'application/pdf' } }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
            })
        }
    );
    const genData = await genRes.json();
    console.log('[8] Done generating in', (Date.now() - startTime) / 1000, 'sec');
    if (genData.error) console.error('Gen Error:', genData.error);
    else console.log('Response length:', JSON.stringify(genData.candidates[0]).length);
}
test().catch(console.error);
