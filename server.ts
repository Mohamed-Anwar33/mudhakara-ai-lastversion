
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import ingestFileHandler from './api/ingest-file';
import processQueueHandler from './api/process-queue';
import jobStatusHandler from './api/job-status';

dotenv.config();

const app = express();
const port = 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Debug Middleware: Log all requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Initialize Clients
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});


console.log("🔹 API Server starting...");
console.log("🔹 OpenAI Key present:", !!process.env.OPENAI_API_KEY);
console.log("🔹 Supabase URL:", process.env.VITE_SUPABASE_URL);

// --- API Routes ---
import apiRoutes from './api/routes';
app.use('/api', apiRoutes);

const adaptVercelHandler = (handler: (req: any, res: any) => Promise<any>) => {
    return async (req: any, res: any) => {
        await handler(req as any, res as any);
    };
};

// Keep local dev behavior aligned with production API contracts.
app.post('/api/ingest-file', adaptVercelHandler(ingestFileHandler));
app.get('/api/job-status', adaptVercelHandler(jobStatusHandler));
app.post('/api/process-queue', adaptVercelHandler(processQueueHandler));
app.get('/api/process-queue', adaptVercelHandler(processQueueHandler));

// 1. Transcribe Endpoint (Primary: OpenAI Whisper, Fallback: Gemini 2.0 Flash)
app.post('/api/transcribe', async (req, res) => {
    try {
        const { fileUrl, mimeType } = req.body;

        if (!fileUrl) {
            return res.status(400).json({ error: 'fileUrl is required' });
        }

        console.log(`🎙️ Transcribing: ${fileUrl}`);

        // Download file from URL
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) throw new Error(`Failed to fetch file: ${fileResponse.statusText}`);

        const arrayBuffer = await fileResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`📦 File size: ${buffer.length} bytes`);

        let transcript = '';

        // --- PRIMARY: Try OpenAI Whisper ---
        if (process.env.OPENAI_API_KEY) {
            try {
                console.log('🔹 Trying OpenAI Whisper...');
                const file = new File([buffer], 'audio.mp3', { type: mimeType || 'audio/mp3' });
                const transcription = await openai.audio.transcriptions.create({
                    file: file,
                    model: 'whisper-1',
                    language: 'ar',
                });
                transcript = transcription.text;
                console.log(`✅ OpenAI Transcription complete: ${transcript.substring(0, 50)}...`);
            } catch (openaiErr: any) {
                console.warn('⚠️ OpenAI Whisper failed:', openaiErr.message);
                console.log('🔄 Falling back to Gemini...');
            }
        }

        // --- FALLBACK: Use Gemini 2.0 Flash for transcription ---
        if (!transcript) {
            const geminiApiKey = process.env.GEMINI_API_KEY;
            if (!geminiApiKey) throw new Error('No API key available for transcription (both OpenAI and Gemini keys missing)');

            console.log('🤖 Using Gemini 2.0 Flash for transcription...');

            // Convert audio to base64 for Gemini inline data
            const base64Audio = buffer.toString('base64');
            const audioMime = mimeType || 'audio/mp3';

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;

            const geminiResponse = await fetch(geminiUrl, {
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
            });

            const geminiData = await geminiResponse.json();

            if (!geminiResponse.ok) {
                console.error('Gemini Transcription Error:', JSON.stringify(geminiData, null, 2));
                throw new Error(geminiData.error?.message || `Gemini transcription failed: ${geminiResponse.status}`);
            }

            transcript = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            console.log(`✅ Gemini Transcription complete: ${transcript.substring(0, 50)}...`);
        }

        if (!transcript) {
            throw new Error('فشل تحويل الصوت إلى نص من جميع المصادر');
        }

        res.json({ transcript });

    } catch (error: any) {
        console.error('❌ Transcription Error:', error);
        res.status(500).json({ error: error.message || 'Transcription failed' });
    }
});

// 4. Gemini Proxy
app.post('/api/gemini', async (req, res) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY is missing');

        // Gemini 2.5 Flash endpoint
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        console.log('🤖 Sending request to Gemini...');

        // Transform the client request into the correct Gemini API format
        const { contents, systemInstruction, generationConfig, responseSchema, remoteFiles, ...rest } = req.body;

        const geminiBody: any = { contents };

        // Fix systemInstruction: must be { parts: [{ text }] }, not a plain string
        if (systemInstruction) {
            if (typeof systemInstruction === 'string') {
                geminiBody.system_instruction = { parts: [{ text: systemInstruction }] };
            } else {
                geminiBody.system_instruction = systemInstruction;
            }
        }

        // Fix generationConfig & responseSchema: responseSchema belongs inside generationConfig
        // Always ensure generationConfig exists with adequate output budget for gemini-2.5-flash
        geminiBody.generationConfig = { ...(generationConfig || {}) };

        // Gemini 2.5 Flash uses thinking tokens from output budget — maximize output
        if (!geminiBody.generationConfig.maxOutputTokens || geminiBody.generationConfig.maxOutputTokens < 65536) {
            geminiBody.generationConfig.maxOutputTokens = 65536;
        }

        // Remove thinkingConfig from generationConfig if accidentally placed there
        delete geminiBody.generationConfig.thinkingConfig;

        if (responseSchema) {
            geminiBody.generationConfig.responseMimeType = 'application/json';
            geminiBody.generationConfig.responseSchema = responseSchema;
        }

        // Note: thinkingConfig is NOT a valid Gemini API field — removed to prevent 400 errors

        // Note: 'remoteFiles' is intentionally stripped — not a valid Gemini API field

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Gemini API Error:', JSON.stringify(data, null, 2));
            return res.status(response.status).json(data);
        }

        // Extract the text from the Gemini response for easier client-side usage
        const finishReason = data.candidates?.[0]?.finishReason;
        const text = data.candidates?.[0]?.content?.parts?.filter((p: any) => p.text)?.map((p: any) => p.text)?.join('') || '';
        console.log(`✅ Gemini Response Received, length: ${text.length}, finishReason: ${finishReason}`);

        // Try to parse JSON response
        let parsedData = null;
        try {
            parsedData = JSON.parse(text);
        } catch (e) {
            // Not JSON, that's ok
        }

        res.json({ data: parsedData, rawText: text, raw: data });

    } catch (error: any) {
        console.error('❌ Gemini Proxy Error:', error);
        res.status(500).json({ error: error.message });
    }
});


app.listen(port, () => {
    console.log(`🚀 API Server running at http://localhost:${port}`);
});
