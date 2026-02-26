
import { supabase } from './supabaseService';

/**
 * خدمة تحليل المحتوى - تربط الواجهة الأمامية بالـ Ingestion Pipeline
 * 
 * المسؤوليات:
 * 1. حساب SHA-256 للملفات (client-side dedup)
 * 2. رفع الملفات لـ Supabase Storage
 * 3. إرسال metadata لـ ingest-file function
 * 4. Polling لحالة المعالجة
 */

// ============================================================================
// 1. TYPES
// ============================================================================

export interface IngestResponse {
    filePath?: string;
    fileName?: string;
    status: 'queued' | 'duplicate' | 'already_queued' | 'failed';
    jobId?: string;
    message: string;
    existingLessonId?: string;
    cachedTranscription?: string;
}

export interface IngestBatchResponse {
    success: boolean;
    lessonId: string;
    results: IngestResponse[];
}

export interface JobStatus {
    id: string;
    job_type: string;
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
    attempts: number;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
}

export interface LessonJobsResponse {
    jobs: JobStatus[];
    lessonStatus: string | null;
    analysisResult: Record<string, any> | null;
}

// ============================================================================
// 2. FILE HASH — SHA-256 (Client-Side)
// ============================================================================

/**
 * حساب SHA-256 hash لملف باستخدام Web Crypto API.
 * يُستخدم للـ Idempotency — منع رفع نفس الملف مرتين.
 */
export async function computeFileHash(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// 3. FILE UPLOAD — Supabase Storage
// ============================================================================

/**
 * يرفع ملف إلى Supabase Storage bucket "raw-files".
 * المسار: raw-files/{lessonId}/{timestamp}_{filename}
 */
export async function uploadFileToStorage(
    file: File,
    lessonId: string
): Promise<string> {
    if (!supabase) {
        throw new Error('Supabase غير متصل');
    }

    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `${lessonId}/${timestamp}_${safeName}`;

    const { error } = await supabase.storage
        .from('homework-uploads')
        .upload(filePath, file, {
            cacheControl: '3600',
            upsert: false
        });

    if (error) {
        throw new Error(`فشل رفع الملف: ${error.message}`);
    }

    return filePath;
}

// ============================================================================
// 4. INGEST — إرسال metadata للمعالجة
// ============================================================================

type FileType = 'pdf' | 'audio' | 'image';

/**
 * يحدد نوع الملف من MIME type.
 */
function detectFileType(file: File): FileType {
    const mime = file.type.toLowerCase();

    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'image';

    throw new Error(`نوع الملف غير مدعوم: ${mime}`);
}

const MAX_AUDIO_SIZE_BYTES = 200 * 1024 * 1024; // 200MB — Gemini File API يدعم ملفات كبيرة

/**
 * يتحقق من حجم الملف قبل الرفع.
 */
function validateFileSize(file: File, fileType: FileType): void {
    if (fileType === 'audio' && file.size > MAX_AUDIO_SIZE_BYTES) {
        throw new Error(
            `حجم الملف الصوتي (${(file.size / 1024 / 1024).toFixed(1)}MB) ` +
            `يتجاوز الحد المسموح (200MB). يرجى ضغط الملف أو تقسيمه.`
        );
    }
}

/**
 * Pipeline كامل: Hash → Upload → Ingest
 * 
 * @param file - الملف المُراد معالجته
 * @param lessonId - معرف الدرس
 * @param onProgress - callback للتقدم (0-100)
 * @returns نتيجة الاستقبال
 */
export async function ingestFile(
    file: File,
    lessonId: string,
    onProgress?: (step: string, percent: number) => void
): Promise<IngestResponse> {
    // Step 1: Compute hash
    onProgress?.('جاري حساب بصمة الملف...', 10);
    const contentHash = await computeFileHash(file);

    // Step 2: Detect file type + validate size
    const fileType = detectFileType(file);
    validateFileSize(file, fileType);

    // Step 3: Upload to Storage
    onProgress?.('جاري رفع الملف...', 30);
    const filePath = await uploadFileToStorage(file, lessonId);

    // Step 4: Send to ingest API
    // Step 4: Insert directly into analysis_jobs to bypass Vercel Timeout limits
    onProgress?.('جاري تسجيل الملف للمعالجة الخلفية...', 70);

    const { data: jobData, error: jobError } = await supabase
        .from('analysis_jobs')
        .insert({
            lesson_id: lessonId,
            file_path: filePath,
            file_type: fileType,
            status: fileType === 'pdf' || fileType === 'image' || fileType === 'audio' ? 'pending' : 'completed', // Only async process heavy files
            progress_percent: 0
        })
        .select('id')
        .single();

    if (jobError || !jobData) {
        throw new Error(`فشل التسجيل في طابور المعالجة: ${jobError?.message}`);
    }

    // Trigger the webhook/edge function artificially (if you don't use DB webhooks)
    // Here we assume Supabase Database Webhooks are configured to listen to `INSERT on analysis_jobs`
    // and fire the respective Edge Function.

    onProgress?.('تم بنجاح! جاري المعالجة الذكية في الخلفية...', 100);

    return {
        status: 'queued',
        jobId: jobData.id,
        message: 'تمت إضافته إلى طابور المعالجة',
        filePath,
        fileName: file.name
    };
}

export async function triggerQueueWorker(maxJobs: number = 1): Promise<any> {
    const response = await fetch(`/api/process-queue?maxJobs=${maxJobs}&t=${Date.now()}`, {
        method: 'POST'
    });

    const payload = await response.json().catch(() => ({}));

    // 504 Gateway Timeout is normal on Vercel free tier — Edge Function still runs in background
    if (response.status === 504) {
        return { status: 'dispatched', message: 'Worker dispatched (background)' };
    }

    if (!response.ok) {
        throw new Error(payload?.error || `فشل تشغيل عامل المعالجة: ${response.status}`);
    }

    return payload;
}

// ============================================================================
// 5. POLLING — متابعة حالة المعالجة
// ============================================================================

/**
 * يجلب حالة جميع الوظائف لدرس معين.
 */
export async function getJobStatus(lessonId: string): Promise<LessonJobsResponse> {
    // Read from Supabase instead of Vercel API to get real-time Async job data
    const { data: jobs, error: jobsError } = await supabase
        .from('analysis_jobs')
        .select('*')
        .eq('lesson_id', lessonId)
        .order('created_at', { ascending: false });

    if (jobsError) {
        throw new Error(`فشل جلب حالة المهام من قاعدة البيانات: ${jobsError.message}`);
    }

    const { data: output, error: outputError } = await supabase
        .from('final_lesson_output')
        .select('massive_summary, focus_points, quiz')
        .eq('lesson_id', lessonId)
        .single();

    // Convert to our expected return format
    let lessonStatus = 'pending';
    if (jobs && jobs.length > 0) {
        const allCompleted = jobs.every(j => j.status === 'completed');
        const anyFailed = jobs.some(j => j.status === 'failed');
        if (anyFailed) lessonStatus = 'failed';
        else if (allCompleted) lessonStatus = 'completed';
        else lessonStatus = 'processing';
    }

    return {
        jobs: jobs || [],
        lessonStatus: lessonStatus,
        analysisResult: output || null
    };
}

/**
 * Polling ذكي: يستعلم كل interval ويتوقف عند الاكتمال أو الفشل.
 * 
 * @param lessonId - معرف الدرس
 * @param onUpdate - callback عند كل تحديث
 * @param intervalMs - الفاصل بين الاستعلامات (افتراضي 5 ثوانٍ)
 * @param maxAttempts - الحد الأقصى للمحاولات (افتراضي 200)
 * @returns Promise تنتهي عند اكتمال المعالجة
 */
export function pollJobStatus(
    lessonId: string,
    onUpdate: (response: LessonJobsResponse) => void,
    intervalMs: number = 5000,
    maxAttempts: number = 200
): { promise: Promise<LessonJobsResponse>; cancel: () => void } {
    let cancelled = false;
    let attempt = 0;
    let backoffMs = intervalMs;

    const cancel = () => { cancelled = true; };

    const promise = new Promise<LessonJobsResponse>((resolve, reject) => {
        const poll = async () => {
            if (cancelled) {
                reject(new Error('Polling cancelled'));
                return;
            }

            if (attempt >= maxAttempts) {
                reject(new Error('تجاوز الوقت المحدد للمعالجة'));
                return;
            }

            try {
                attempt++;
                const status = await getJobStatus(lessonId);

                // Reset backoff on success
                backoffMs = intervalMs;

                onUpdate(status);

                const allTerminal = status.jobs.length > 0 && status.jobs.every(
                    j => j.status === 'completed' || j.status === 'failed' || j.status === 'dead'
                );
                const pipelineDone = status.lessonStatus === 'completed' || status.lessonStatus === 'failed';

                if (allTerminal && pipelineDone) {
                    resolve(status);
                    return;
                }

                setTimeout(poll, backoffMs);
            } catch (err: any) {
                console.warn(`[Polling] Attempt ${attempt} failed: ${err.message}. Retrying...`);

                // Exponential backoff for 5xx errors like 504 Gateway Timeout
                if (err.message.includes('504') || err.message.includes('500') || err.message.includes('502')) {
                    backoffMs = Math.min(backoffMs * 1.5, 15000); // Max backoff 15s
                } else {
                    backoffMs = intervalMs;
                }

                setTimeout(poll, backoffMs);
            }
        };

        // Start first poll
        setTimeout(poll, 500);
    });

    return { promise, cancel };
}
