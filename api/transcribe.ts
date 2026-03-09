import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel API Route: POST /api/transcribe
 * 
 * Audio transcription: Uses Gemini for transcription (no OpenAI dependency).
 * Mirrors server.ts /api/transcribe handler behavior.
 * Accepts: { fileUrl: string, mimeType?: string }
 */

export const config = {
    maxDuration: 10 // Vercel Hobby max
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { fileUrl, mimeType } = req.body;

        if (!fileUrl) {
            return res.status(400).json({ error: 'fileUrl is required' });
        }

        console.log(`🎙️ Transcribing: ${fileUrl.substring(0, 80)}...`);

        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (!geminiApiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
        }

        // Download file from URL
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) throw new Error(`Failed to fetch file: ${fileResponse.statusText}`);

        const arrayBuffer = await fileResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`📦 File size: ${buffer.length} bytes`);

        // Use Gemini File API for large files (>4MB inline limit)
        let transcript = '';

        if (buffer.length > 4 * 1024 * 1024) {
            // Large file → upload to Gemini File API first
            console.log('📎 Large file, uploading to Gemini File API...');
            const audioMime = mimeType || 'audio/mp3';

            const uploadRes = await fetch(
                `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiApiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': audioMime,
                        'X-Goog-Upload-Display-Name': 'transcribe_audio',
                    },
                    body: buffer,
                }
            );

            if (!uploadRes.ok) throw new Error(`File upload failed: ${uploadRes.status}`);

            const uploadData = await uploadRes.json();
            const fileUri = uploadData.file?.uri;
            if (!fileUri) throw new Error('No file URI returned from upload');

            // Wait for processing
            await new Promise(r => setTimeout(r, 2000));

            const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: 'أنت مفرّغ صوتي محترف. حوّل الصوت التالي إلى نص عربي مكتوب بدقة. اكتب النص فقط بدون أي مقدمات أو تعليقات.' },
                                { fileData: { fileUri, mimeType: audioMime } }
                            ]
                        }],
                        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
                    })
                }
            );

            const geminiData = await geminiRes.json();
            if (!geminiRes.ok) throw new Error(geminiData.error?.message || `Gemini failed: ${geminiRes.status}`);
            transcript = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
            // Small file → inline data
            console.log('🤖 Using Gemini with inline data...');
            const base64Audio = buffer.toString('base64');
            const audioMime = mimeType || 'audio/mp3';

            const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: 'أنت مفرّغ صوتي محترف. حوّل الصوت التالي إلى نص عربي مكتوب بدقة. اكتب النص فقط بدون أي مقدمات أو تعليقات.' },
                                { inlineData: { data: base64Audio, mimeType: audioMime } }
                            ]
                        }],
                        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
                    })
                }
            );

            const geminiData = await geminiRes.json();
            if (!geminiRes.ok) throw new Error(geminiData.error?.message || `Gemini failed: ${geminiRes.status}`);
            transcript = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        if (!transcript) {
            throw new Error('فشل تحويل الصوت إلى نص');
        }

        console.log(`✅ Transcription complete: ${transcript.substring(0, 50)}...`);
        return res.status(200).json({ transcript });

    } catch (error: any) {
        console.error('❌ Transcription Error:', error.message);
        return res.status(500).json({ error: error.message || 'Transcription failed' });
    }
}
