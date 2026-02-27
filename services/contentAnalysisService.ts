
import { supabase } from './supabaseService';

/**
 * خدمة تحليل المحتوى - تربط الواجهة الأمامية بالـ Ingestion Pipeline
 * 
 * المسؤوليات:
 * 1. حساب SHA-256 للملفات (client-side dedup)
 * 2. رفع الملفات لـ Supabase Storage
 * 3. إرسال metadata لـ /api/ingest-file endpoint
 * 4. Polling لحالة المعالجة عبر processing_queue + lessons
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
    stage?: string;
    progress?: number;
    attempt_count: number;
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
 * يرفع ملف إلى Supabase Storage bucket "homework-uploads".
 * المسار: homework-uploads/{lessonId}/{timestamp}_{filename}
 */
export async function uploadFileToStorage(
    file: File,
    lessonId: string
): Promise<string> {
    if (!supabase) {
        throw new Error('Supabase غير متصل');
    }

    // Force refresh the session to prevent "exp claim timestamp check failed" (403 Error)
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
        console.warn("No active session or session error, attempting to refresh...");
        await supabase.auth.refreshSession();
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
 * Pipeline كامل: Hash → Upload → Ingest via /api/ingest-file
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

    // Step 4: Send to /api/ingest-file (the REAL pipeline endpoint)
    onProgress?.('جاري تسجيل الملف للمعالجة الخلفية...', 70);

    const response = await fetch('/api/ingest-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lessonId,
            files: [{
                filePath,
                fileName: file.name,
                fileType,
                contentHash
            }],
            forceReextract: false
        })
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `فشل التسجيل: ${response.status}`);
    }

    const data = await response.json();
    const result = data.results?.[0] || data;

    onProgress?.('تم بنجاح! جاري المعالجة الذكية في الخلفية...', 100);

    return {
        status: result.status || 'queued',
        jobId: result.jobId,
        message: result.message || 'تمت إضافته إلى طابور المعالجة',
        filePath: result.filePath || filePath,
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
// 5. POLLING — متابعة حالة المعالجة (uses processing_queue + lessons tables)
// ============================================================================

/**
 * يجلب حالة جميع الوظائف لدرس معين من processing_queue + lessons.
 */
export async function getJobStatus(lessonId: string): Promise<LessonJobsResponse> {
    if (!supabase) throw new Error('Supabase غير متصل');

    // Query the REAL pipeline table: processing_queue
    const { data: jobs, error: jobsError } = await supabase
        .from('processing_queue')
        .select('id, job_type, status, stage, progress, attempt_count, error_message, created_at, completed_at')
        .eq('lesson_id', lessonId)
        .order('created_at', { ascending: true });

    if (jobsError) {
        throw new Error(`فشل جلب حالة المهام من قاعدة البيانات: ${jobsError.message}`);
    }

    // Get the lesson's analysis_result directly
    const { data: lesson, error: lessonError } = await supabase
        .from('lessons')
        .select('analysis_status, analysis_result')
        .eq('id', lessonId)
        .single();

    if (lessonError && lessonError.code !== 'PGRST116') {
        throw new Error(`فشل جلب حالة الدرس: ${lessonError.message}`);
    }

    // Determine overall lesson status
    let lessonStatus = lesson?.analysis_status || 'pending';

    return {
        jobs: (jobs || []).map(j => ({
            id: j.id,
            job_type: j.job_type,
            status: j.status,
            stage: j.stage,
            progress: j.progress,
            attempt_count: j.attempt_count,
            error_message: j.error_message,
            created_at: j.created_at,
            completed_at: j.completed_at
        })),
        lessonStatus,
        analysisResult: lesson?.analysis_result || null
    };
}

/**
 * Polling ذكي: يستعلم كل interval ويتوقف عند الاكتمال أو الفشل.
 * Also triggers the queue worker on each poll to keep processing alive.
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

                // Trigger the orchestrator on every poll to keep the pipeline moving
                // This is critical because Vercel Free cron only runs once daily
                triggerQueueWorker(1).catch(() => { });

                const status = await getJobStatus(lessonId);

                // Reset backoff on success
                backoffMs = intervalMs;

                onUpdate(status);

                const pipelineDone = status.lessonStatus === 'completed' || status.lessonStatus === 'failed';

                if (pipelineDone) {
                    resolve(status);
                    return;
                }

                // Check if all non-completed jobs are stuck
                const activeJobs = status.jobs.filter(
                    j => j.status === 'pending' || j.status === 'processing'
                );
                const allTerminal = status.jobs.length > 0 && activeJobs.length === 0;

                if (allTerminal && !pipelineDone) {
                    // All jobs done but lesson not marked complete — give it one more cycle
                    setTimeout(poll, backoffMs);
                    return;
                }

                setTimeout(poll, backoffMs);
            } catch (err: any) {
                console.warn(`[Polling] Attempt ${attempt} failed: ${err.message}. Retrying...`);

                // Exponential backoff for errors
                if (err.message.includes('504') || err.message.includes('500') || err.message.includes('502')) {
                    backoffMs = Math.min(backoffMs * 1.5, 15000);
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
