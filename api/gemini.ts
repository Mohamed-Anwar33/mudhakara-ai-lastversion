import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel API Route: POST /api/gemini
 * 
 * Proxy for Gemini API calls from the client.
 * Mirrors the exact behavior of server.ts /api/gemini handler.
 * Accepts: contents, systemInstruction, responseSchema, fileUrl, mimeType
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    try {
        const { contents, systemInstruction, generationConfig, responseSchema, fileUrl, mimeType } = req.body;

        const geminiBody: any = { contents };

        // Fix systemInstruction: must be { parts: [{ text }] }, not a plain string
        // Use snake_case key 'system_instruction' for Gemini API
        if (systemInstruction) {
            if (typeof systemInstruction === 'string') {
                geminiBody.system_instruction = { parts: [{ text: systemInstruction }] };
            } else {
                geminiBody.system_instruction = systemInstruction;
            }
        }

        // generationConfig with adequate output budget
        geminiBody.generationConfig = { ...(generationConfig || {}) };
        if (!geminiBody.generationConfig.maxOutputTokens || geminiBody.generationConfig.maxOutputTokens < 65536) {
            geminiBody.generationConfig.maxOutputTokens = 65536;
        }
        delete geminiBody.generationConfig.thinkingConfig;

        // responseSchema → structured JSON output
        if (responseSchema) {
            geminiBody.generationConfig.responseMimeType = 'application/json';
            geminiBody.generationConfig.responseSchema = responseSchema;
        }

        // Handle remote file URL — upload to Gemini File API
        if (fileUrl) {
            try {
                const fileMime = mimeType || 'application/octet-stream';
                console.log(`[gemini-proxy] Uploading remote file...`);

                const fileResponse = await fetch(fileUrl);
                if (!fileResponse.ok) throw new Error(`Failed to download file: ${fileResponse.status}`);
                const fileBuffer = await fileResponse.arrayBuffer();

                const uploadRes = await fetch(
                    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': fileMime,
                            'X-Goog-Upload-Display-Name': 'homework_upload',
                        },
                        body: Buffer.from(fileBuffer),
                    }
                );

                if (uploadRes.ok) {
                    const uploadData = await uploadRes.json();
                    const geminiFileUri = uploadData.file?.uri;
                    if (geminiFileUri) {
                        await new Promise(r => setTimeout(r, 2000));
                        if (geminiBody.contents?.[0]?.parts) {
                            geminiBody.contents[0].parts.push({
                                fileData: { fileUri: geminiFileUri, mimeType: fileMime }
                            });
                        }
                        console.log(`[gemini-proxy] ✅ File uploaded`);
                    }
                } else {
                    console.warn(`[gemini-proxy] ⚠️ File upload failed: ${uploadRes.status}`);
                }
            } catch (fileErr: any) {
                console.warn(`[gemini-proxy] ⚠️ File handling error:`, fileErr.message);
            }
        }

        // Call Gemini API
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('[gemini-proxy] Gemini API Error:', JSON.stringify(data).substring(0, 500));
            return res.status(response.status).json(data);
        }

        // Extract text — MATCHING server.ts format exactly
        const finishReason = data.candidates?.[0]?.finishReason;
        const text = data.candidates?.[0]?.content?.parts
            ?.filter((p: any) => p.text)?.map((p: any) => p.text)?.join('') || '';
        console.log(`✅ Gemini Response, length: ${text.length}, finishReason: ${finishReason}`);

        // Try to parse JSON response
        let parsedData = null;
        try {
            parsedData = JSON.parse(text);
        } catch (e) {
            // Not JSON, that's ok
        }

        // Return SAME format as server.ts: { data, rawText, raw }
        return res.status(200).json({ data: parsedData, rawText: text, raw: data });

    } catch (err: any) {
        console.error('[gemini-proxy] Error:', err.message);
        return res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
