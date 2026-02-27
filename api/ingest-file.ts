import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const config = {
    maxDuration: 30
};

type SupportedFileType = 'pdf' | 'audio' | 'image';

interface LegacyIngestRequest {
    lessonId: string;
    fileName?: string;
    filePath: string;
    fileType: string;
    contentHash?: string;
}

interface BatchFileInput {
    fileName?: string;
    filePath?: string;
    fileType?: string;
    contentHash?: string;
    name?: string;
    path?: string;
    type?: string;
}

interface BatchIngestRequest {
    lessonId: string;
    files: BatchFileInput[];
    forceReextract?: boolean;
}

interface NormalizedFile {
    fileName: string;
    filePath: string;
    fileType: SupportedFileType;
    contentHash?: string;
}

interface NormalizedRequest {
    lessonId: string;
    files: NormalizedFile[];
    isLegacy: boolean;
    forceReextract: boolean;
}

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }

    return createClient(url, serviceKey);
};

function normalizeStoragePath(pathValue: string): string {
    return decodeURIComponent(pathValue.trim()).replace(/^\/+/, '').split('?')[0];
}

function inferFileTypeFromName(nameOrPath: string): SupportedFileType | null {
    const lower = nameOrPath.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (/\.(mp3|wav|m4a|mp4|ogg|webm)$/i.test(lower)) return 'audio';
    if (/\.(jpg|jpeg|png|webp)$/i.test(lower)) return 'image';
    return null;
}

function normalizeFileType(fileType: string | undefined, fileName: string, filePath: string): SupportedFileType | null {
    const normalized = (fileType || '').toLowerCase();
    if (normalized === 'pdf') return 'pdf';
    if (normalized === 'audio') return 'audio';
    if (normalized === 'image') return 'image';

    // Backward compatibility: some callers send "document" for PDFs.
    if (normalized === 'document') {
        return inferFileTypeFromName(fileName) || inferFileTypeFromName(filePath);
    }

    return inferFileTypeFromName(fileName) || inferFileTypeFromName(filePath);
}

function buildFallbackContentHash(lessonId: string, filePath: string, fileType: SupportedFileType): string {
    return createHash('sha256')
        .update(`${lessonId}:${filePath}:${fileType}`)
        .digest('hex');
}

function normalizeBody(body: any): { request?: NormalizedRequest; error?: string } {
    if (!body || typeof body !== 'object') {
        return { error: 'Body is required' };
    }

    // New contract: { lessonId, files: [...] }
    if (Array.isArray(body.files)) {
        const payload = body as BatchIngestRequest;
        if (!payload.lessonId) {
            return { error: 'lessonId is required' };
        }
        if (payload.files.length === 0) {
            return { error: 'files array must not be empty' };
        }

        const normalizedFiles: NormalizedFile[] = [];
        for (const file of payload.files) {
            const rawFilePath = file?.filePath || file?.path;
            if (!rawFilePath) {
                return { error: 'Each file requires filePath' };
            }

            const safePath = normalizeStoragePath(rawFilePath);
            const inferredName = file.fileName || file.name || safePath.split('/').pop() || safePath;
            const normalizedType = normalizeFileType(file.fileType || file.type, inferredName, safePath);
            if (!normalizedType) {
                return { error: `Unsupported file type for ${inferredName}. Allowed: pdf, audio, image` };
            }

            normalizedFiles.push({
                fileName: inferredName,
                filePath: safePath,
                fileType: normalizedType,
                contentHash: file.contentHash?.trim() || undefined
            });
        }

        return {
            request: {
                lessonId: payload.lessonId,
                files: normalizedFiles,
                isLegacy: false,
                forceReextract: !!payload.forceReextract
            }
        };
    }

    // Backward compatibility: legacy single-file request.
    const legacy = body as LegacyIngestRequest;
    if (!legacy.lessonId || !legacy.filePath) {
        return { error: 'Required fields: lessonId, filePath' };
    }

    const normalizedPath = normalizeStoragePath(legacy.filePath);
    const inferredName = legacy.fileName || normalizedPath.split('/').pop() || normalizedPath;
    const normalizedType = normalizeFileType(legacy.fileType, inferredName, normalizedPath);
    if (!normalizedType) {
        return { error: `Unsupported file type for ${inferredName}. Allowed: pdf, audio, image` };
    }

    return {
        request: {
            lessonId: legacy.lessonId,
            files: [{
                fileName: inferredName,
                filePath: normalizedPath,
                fileType: normalizedType,
                contentHash: legacy.contentHash?.trim() || undefined
            }],
            isLegacy: true,
            forceReextract: false
        }
    };
}

function extractAllowedPathsFromSources(sources: any[]): Set<string> {
    const allowed = new Set<string>();

    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;

        const candidates = [
            source.path,
            source.file_path,
            source.filePath,
            source.storagePath
        ].filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);

        for (const candidate of candidates) {
            allowed.add(normalizeStoragePath(candidate));
        }

        if (typeof source.uploadedUrl === 'string' && source.uploadedUrl.includes('/homework-uploads/')) {
            const split = source.uploadedUrl.split('/homework-uploads/');
            const rawPath = split[1];
            if (rawPath) {
                allowed.add(normalizeStoragePath(rawPath));
            }
        }
    }

    return allowed;
}

function mapFileTypeToJobType(fileType: SupportedFileType): 'pdf_extract' | 'audio_transcribe' | 'image_ocr' {
    if (fileType === 'pdf') return 'pdf_extract';
    if (fileType === 'audio') return 'audio_transcribe';
    return 'image_ocr';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const normalized = normalizeBody(req.body);
        if (!normalized.request) {
            return res.status(400).json({ error: normalized.error || 'Invalid ingest payload' });
        }

        const { lessonId, files, isLegacy, forceReextract } = normalized.request;
        const supabase = getSupabaseAdmin();

        if (forceReextract) {
            console.log(`[Ingest] forceReextract=true for lesson ${lessonId}. Purging old data to force full re-extraction.`);

            // CRITICAL: Reset lesson status FIRST synchronously — before anything else
            // This prevents the frontend from seeing stale 'failed' status during polling
            await supabase.from('lessons').update({
                analysis_status: 'pending',
                analysis_result: null
            }).eq('id', lessonId);

            // Then purge old pipeline data in parallel
            await Promise.allSettled([
                supabase.from('processing_queue').delete().eq('lesson_id', lessonId),
                supabase.from('file_hashes').delete().eq('lesson_id', lessonId),
                supabase.from('document_sections').delete().eq('lesson_id', lessonId),
                supabase.from('lecture_segments').delete().eq('lesson_id', lessonId),
                supabase.from('book_analysis').delete().eq('lesson_id', lessonId),
            ]);
        }

        const { data: lesson, error: lessonError } = await supabase
            .from('lessons')
            .select('id, sources')
            .eq('id', lessonId)
            .single();

        if (lessonError || !lesson) {
            return res.status(404).json({ error: 'Lesson not found' });
        }

        const allowedPaths = extractAllowedPathsFromSources(Array.isArray(lesson.sources) ? lesson.sources : []);

        const results: Array<Record<string, any>> = [];
        let hasQueued = false;

        for (const file of files) {
            const filePath = normalizeStoragePath(file.filePath);

            if (!allowedPaths.has(filePath)) {
                results.push({
                    filePath,
                    fileName: file.fileName,
                    status: 'failed',
                    message: 'Unauthorized filePath for this lesson'
                });
                continue;
            }

            const contentHash = file.contentHash || buildFallbackContentHash(lessonId, filePath, file.fileType);

            const { data: existingHash, error: existingError } = await supabase
                .from('file_hashes')
                .select('id, lesson_id, transcription')
                .eq('lesson_id', lessonId)
                .eq('content_hash', contentHash)
                .maybeSingle();

            if (existingError) throw existingError;

            if (existingHash) {
                results.push({
                    filePath,
                    fileName: file.fileName,
                    status: 'duplicate',
                    message: 'File already processed for this lesson',
                    existingLessonId: existingHash.lesson_id,
                    cachedTranscription: existingHash.transcription
                });
                continue;
            }

            const { error: hashError } = await supabase
                .from('file_hashes')
                .insert({
                    content_hash: contentHash,
                    lesson_id: lessonId,
                    source_type: file.fileType,
                    file_path: filePath
                });

            if (hashError) {
                if (hashError.code === '23505') {
                    results.push({
                        filePath,
                        fileName: file.fileName,
                        status: 'duplicate',
                        message: 'File hash already registered for this lesson'
                    });
                    continue;
                }
                throw hashError;
            }

            let initialJobType = 'extract_pdf_info';
            if (file.fileType === 'audio') initialJobType = 'transcribe_audio';
            if (file.fileType === 'image') initialJobType = 'image_ocr';

            // V2 Architecture: Direct to specialized extraction workers
            const { data: job, error: queueError } = await supabase
                .from('processing_queue')
                .insert({
                    lesson_id: lessonId,
                    job_type: initialJobType,
                    payload: {
                        file_path: filePath,
                        file_name: file.fileName,
                        content_hash: contentHash,
                        source_type: file.fileType,
                        ...(initialJobType === 'extract_pdf_info' ? {
                            gemini_file_uri: await uploadToGemini(supabase, filePath),
                            total_pages: 50 // TODO: Use PDF parser or get from Gemini metadata if possible, defaulting to 50 for safety bracket
                        } : {})
                    },
                    status: 'pending'
                })
                .select('id, status')
                .single();

            if (queueError) {
                if (queueError.code === '23505') {
                    results.push({
                        filePath,
                        fileName: file.fileName,
                        status: 'already_queued',
                        message: 'File is already queued'
                    });
                    continue;
                }
                throw queueError;
            }

            hasQueued = true;
            results.push({
                filePath,
                fileName: file.fileName,
                status: 'queued',
                jobId: job?.id,
                message: 'Queued successfully'
            });
        }

        if (hasQueued) {
            await supabase
                .from('lessons')
                .update({ analysis_status: 'pending' })
                .eq('id', lessonId);
        } else {
            // If nothing was queued (e.g. all files duplicate), check if we should trigger analysis
            const { count: pendingExtracts, error: countErr } = await supabase
                .from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lessonId)
                .in('job_type', ['extract_pdf_info', 'transcribe_audio', 'image_ocr', 'ocr_page_batch'])
                .in('status', ['pending', 'processing']);

            if (!countErr && pendingExtracts === 0) {
                // No extractions pending, safe to queue segmentation (V2)
                await supabase.from('processing_queue').insert({
                    lesson_id: lessonId,
                    job_type: 'segment_lesson',
                    status: 'pending'
                });
                await supabase
                    .from('lessons')
                    .update({ analysis_status: 'pending' })
                    .eq('id', lessonId);
            }
        }

        if (isLegacy && results.length === 1) {
            const first = results[0];
            return res.status(first.status === 'failed' ? 403 : 200).json({
                status: first.status,
                jobId: first.jobId,
                message: first.message,
                existingLessonId: first.existingLessonId,
                cachedTranscription: first.cachedTranscription
            });
        }

        return res.status(200).json({
            success: true,
            lessonId,
            results
        });

    } catch (error: any) {
        console.error('Ingest Error:', error);
        return res.status(500).json({
            error: error.message || 'Failed to enqueue files'
        });
    }
}

async function uploadToGemini(supabase: any, storagePath: string): Promise<string> {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error('GEMINI_API_KEY is not set');

    console.log(`[Gemini Upload] Downloading file from Supabase: ${storagePath}`);
    // 1. Download file from Supabase Storage
    const { data: fileBlob, error: downloadError } = await supabase.storage
        .from('homework-uploads')
        .download(storagePath);

    if (downloadError || !fileBlob) {
        throw new Error(`Failed to download file from Supabase: ${downloadError?.message}`);
    }

    const buffer = Buffer.from(await fileBlob.arrayBuffer());

    // 2. Write to temp file
    const tempFilePath = path.join(os.tmpdir(), `gemini_upload_${Date.now()}.pdf`);
    fs.writeFileSync(tempFilePath, buffer);

    try {
        console.log(`[Gemini Upload] Uploading to Gemini File API...`);
        const ai = new GoogleGenAI({ apiKey: geminiKey });

        // 3. Upload to Gemini
        const uploadResponse = await ai.files.upload({
            file: tempFilePath,
        });

        console.log(`[Gemini Upload] Success, URI: ${uploadResponse.uri}`);
        return uploadResponse.uri!;
    } finally {
        // 4. Cleanup temp file
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
    }
}
