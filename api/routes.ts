
import express from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { processPdfJob } from './_lib/pdf-processor';
import { processAudioJob } from './_lib/audio-processor';
import { processImageJob } from './_lib/image-processor';
import { generateLessonAnalysis } from './_lib/analysis';
import { embedLessonSections } from './_lib/embeddings';
import { segmentBook } from './_lib/book-segmenter';

const router = express.Router();

// Lazy-init Supabase Client (avoids running before dotenv.config())
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
    if (!_supabase) {
        _supabase = createClient(
            process.env.VITE_SUPABASE_URL || '',
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
        );
    }
    return _supabase;
}

// ------------------------------------------------------------------
// POST /api/ingest
// Body: { lessonId: string, files: Array<{ path: string, type: 'pdf' | 'audio' }> }
// ------------------------------------------------------------------
router.post('/ingest', async (req, res) => {
    try {
        const { lessonId, files } = req.body;

        if (!lessonId || !files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Missing lessonId or files array' });
        }

        console.log(`📥 Ingesting lesson ${lessonId} with ${files.length} files...`);

        const results = [];

        for (const file of files) {
            console.log(`Processing file: ${file.path} (${file.type})`);

            // Create a content hash (simple for now, ideally strictly from file content)
            const contentHash = `${lessonId}-${file.path}-${Date.now()}`;

            if (file.type === 'pdf' || file.type === 'document' || file.name?.endsWith('.pdf') || file.path?.endsWith('.pdf')) {
                console.log(`[Ingest] Starting PDF processing: ${file.path}`);
                const result = await processPdfJob(getSupabase(), lessonId, file.path, contentHash);
                console.log(`[Ingest] ✅ PDF done: ${result.chunksCreated} chunks, ${result.totalChars} chars, method: ${result.method}`);
                results.push({ file: file.path, status: 'processed', details: result });
            } else if (file.type === 'audio' || file.name?.match(/\.(mp3|wav|m4a|mp4|ogg)$/i) || file.path?.match(/\.(mp3|wav|m4a|mp4|ogg)$/i)) {
                // Audio processing (Whisper -> Chunk -> Embedding)
                const result = await processAudioJob(getSupabase(), lessonId, file.path, contentHash);
                results.push({ file: file.path, status: 'processed', details: result });
            } else if (file.type === 'image' || file.name?.match(/\.(jpg|jpeg|png|webp)$/i)) {
                // Image processing (GPT-4o Vision -> Chunk -> Embedding)
                const result = await processImageJob(getSupabase(), lessonId, file.path, contentHash);
                results.push({ file: file.path, status: 'processed', details: result });
            } else {
                console.warn(`Skipping unsupported file type: ${file.type} (${file.path})`);
                results.push({ file: file.path, status: 'skipped', reason: 'unsupported type' });
            }
        }

        // ─── Generate Embeddings for all new chunks ─────────────
        console.log(`[Ingest] 🔄 Generating embeddings for lesson ${lessonId}...`);
        try {
            const embedResult = await embedLessonSections(getSupabase(), lessonId);
            console.log(`[Ingest] ✅ Embeddings: ${embedResult.newlyEmbedded} new, ${embedResult.alreadyEmbedded} cached, ${embedResult.failedBatches} failed`);
        } catch (embedErr: any) {
            // Non-fatal: analysis can still work without embeddings (direct content fallback)
            console.warn(`[Ingest] ⚠️ Embeddings failed (non-fatal): ${embedErr.message}`);
        }

        res.json({ success: true, results });

    } catch (error: any) {
        console.error('❌ Ingest Error:', error);
        res.status(500).json({ error: error.message || 'Ingestion failed' });
    }
});

// ------------------------------------------------------------------
// POST /api/analyze
// Body: { lessonId: string }
// Query: ?stream=1 (optional — enables Server-Sent Events progress)
// ------------------------------------------------------------------
router.post('/analyze', async (req, res) => {
    try {
        const { lessonId } = req.body;

        if (!lessonId) {
            return res.status(400).json({ error: 'Missing lessonId' });
        }

        const useSSE = req.query.stream === '1';
        console.log(`🧠 Analyzing lesson ${lessonId}${useSSE ? ' (SSE stream)' : ''}...`);

        if (useSSE) {
            // ─── SSE Mode: stream progress events ───────────────
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'  // Disable nginx buffering
            });

            const sendEvent = (data: any) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            try {
                const analysisResult = await generateLessonAnalysis(
                    getSupabase(),
                    lessonId,
                    (step, message, percent) => {
                        sendEvent({ type: 'progress', step, message, percent });
                    }
                );

                sendEvent({ type: 'done', data: analysisResult });
            } catch (error: any) {
                sendEvent({ type: 'error', error: error.message });
            }

            res.end();

        } else {
            // ─── Classic Mode (no streaming) ────────────────────
            const analysisResult = await generateLessonAnalysis(getSupabase(), lessonId);
            res.json({ success: true, data: analysisResult });
        }

    } catch (error: any) {
        console.error('❌ Analysis Error:', error);
        res.status(500).json({ error: error.message || 'Analysis failed' });
    }
});

// ------------------------------------------------------------------
// POST /api/segment-book
// Body: { subjectId: string, filePath: string, userId: string }
// Segments a full textbook PDF into individual lessons automatically.
// ------------------------------------------------------------------
router.post('/segment-book', async (req, res) => {
    try {
        const { subjectId, filePath, userId } = req.body;

        if (!subjectId || !filePath || !userId) {
            return res.status(400).json({
                error: 'Missing required fields: subjectId, filePath, userId'
            });
        }

        console.log(`📚 Segmenting book for subject ${subjectId}...`);
        console.log(`   File: ${filePath}`);

        const result = await segmentBook(getSupabase(), subjectId, userId, filePath, {
            autoAnalyze: false, // Don't analyze yet; wait for user to add audio!
            autoEmbed: true     // Keep embeddings for Focus Extraction (Similarity Score)
        });

        const succeeded = result.lessons.filter(l => l.status !== 'failed').length;
        const failed = result.lessons.filter(l => l.status === 'failed').length;

        res.json({
            success: true,
            message: `تم تقسيم الكتاب إلى ${result.lessonsDetected} درس (${succeeded} نجح، ${failed} فشل)`,
            data: result
        });

    } catch (error: any) {
        console.error('❌ Segment Book Error:', error);
        res.status(500).json({ error: error.message || 'Book segmentation failed' });
    }
});

export default router;
