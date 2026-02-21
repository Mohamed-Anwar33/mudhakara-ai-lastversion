import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Vercel API Route: /api/ingest-file
 * 
 * مسؤول عن:
 * 1. استقبال metadata للملف (الملف يُرفع مباشرة من Frontend إلى Storage)
 * 2. تسجيل hash الملف لمنع التكرار (Idempotency)
 * 3. إنشاء وظيفة في processing_queue للمعالجة اللاحقة
 */

const getSupabaseAdmin = () => {
    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }

    return createClient(url, serviceKey);
};

interface IngestRequest {
    lessonId: string;
    fileName: string;
    filePath: string;
    fileType: 'pdf' | 'audio' | 'image';
    contentHash: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = req.body as IngestRequest;

        if (!body.lessonId || !body.filePath || !body.fileType || !body.contentHash) {
            return res.status(400).json({
                error: 'الحقول المطلوبة: lessonId, filePath, fileType, contentHash'
            });
        }

        const supabase = getSupabaseAdmin();

        // ==========================================
        // 1. Idempotency Check — هل الملف تمت معالجته من قبل؟
        // ==========================================
        const { data: existingHash } = await supabase
            .from('file_hashes')
            .select('id, lesson_id, transcription')
            .eq('content_hash', body.contentHash)
            .maybeSingle();

        if (existingHash) {
            return res.status(200).json({
                status: 'duplicate',
                message: 'هذا الملف تمت معالجته من قبل',
                existingLessonId: existingHash.lesson_id,
                cachedTranscription: existingHash.transcription
            });
        }

        // ==========================================
        // 2. Register File Hash
        // ==========================================
        const { error: hashError } = await supabase
            .from('file_hashes')
            .insert({
                content_hash: body.contentHash,
                lesson_id: body.lessonId,
                source_type: body.fileType,
                file_path: body.filePath
            });

        if (hashError) {
            if (hashError.code === '23505') {
                return res.status(200).json({
                    status: 'duplicate',
                    message: 'تم تسجيل الملف بواسطة طلب آخر'
                });
            }
            throw hashError;
        }

        // ==========================================
        // 3. Map file type to job type
        // ==========================================
        const jobTypeMap: Record<string, string> = {
            'pdf': 'pdf_extract',
            'audio': 'audio_transcribe',
            'image': 'image_ocr'
        };

        // ==========================================
        // 4. Enqueue Processing Job
        // ==========================================
        const { data: job, error: queueError } = await supabase
            .from('processing_queue')
            .insert({
                lesson_id: body.lessonId,
                job_type: jobTypeMap[body.fileType],
                payload: {
                    file_path: body.filePath,
                    file_name: body.fileName,
                    content_hash: body.contentHash,
                    source_type: body.fileType
                },
                status: 'pending'
            })
            .select('id, status')
            .single();

        if (queueError) {
            if (queueError.code === '23505') {
                return res.status(200).json({
                    status: 'already_queued',
                    message: 'يوجد بالفعل وظيفة معالجة لهذا الدرس'
                });
            }
            throw queueError;
        }

        // ==========================================
        // 5. Update lesson status
        // ==========================================
        await supabase
            .from('lessons')
            .update({ analysis_status: 'pending' })
            .eq('id', body.lessonId);

        return res.status(200).json({
            status: 'queued',
            jobId: job.id,
            message: 'تم إضافة الملف لقائمة المعالجة بنجاح'
        });

    } catch (error: any) {
        console.error('Ingest Error:', error);
        return res.status(500).json({
            error: error.message || 'حدث خطأ أثناء استقبال الملف'
        });
    }
}
