
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
    onProgress?.('جاري تسجيل الملف للمعالجة...', 70);
    const response = await fetch('/api/ingest-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lessonId,
            files: [{
                fileName: file.name,
                filePath,
                fileType,
                contentHash
            }]
        })
    });

    const payload = await response.json();

    if (!response.ok) {
        throw new Error(payload?.error || 'فشل استقبال الملف');
    }

    const firstResult = payload?.results?.[0] || payload;
    if (!firstResult || typeof firstResult !== 'object') {
        throw new Error('فشل استقبال الملف');
    }

    onProgress?.('تم بنجاح!', 100);
    return firstResult as IngestResponse;
}

export async function triggerQueueWorker(maxJobs: number = 3): Promise<any> {
    const response = await fetch(`/api/process-queue?maxJobs=${maxJobs}`, {
        method: 'POST'
    });

    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.error || 'فشل تشغيل عامل المعالجة');
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
    const response = await fetch(`/api/job-status?lessonId=${lessonId}`);

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'فشل جلب الحالة');
    }

    return await response.json();
}

/**
 * Polling ذكي: يستعلم كل interval ويتوقف عند الاكتمال أو الفشل.
 * 
 * @param lessonId - معرف الدرس
 * @param onUpdate - callback عند كل تحديث
 * @param intervalMs - الفاصل بين الاستعلامات (افتراضي 3 ثوانٍ)
 * @param maxAttempts - الحد الأقصى للمحاولات (افتراضي 100 = 5 دقائق)
 * @returns Promise تنتهي عند اكتمال المعالجة
 */
export function pollJobStatus(
    lessonId: string,
    onUpdate: (response: LessonJobsResponse) => void,
    intervalMs: number = 3000,
    maxAttempts: number = 100
): { promise: Promise<LessonJobsResponse>; cancel: () => void } {
    let cancelled = false;
    let attempt = 0;

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
                onUpdate(status);

                // Check if pipeline is truly done:
                // - All current jobs must be terminal
                // - AND lessonStatus must be 'completed' or 'failed'
                // (embed/analysis jobs are enqueued AFTER extraction completes,
                //  so jobs alone can't tell us if the pipeline is finished)
                const allTerminal = status.jobs.length > 0 && status.jobs.every(
                    j => j.status === 'completed' || j.status === 'failed' || j.status === 'dead'
                );
                const pipelineDone = status.lessonStatus === 'completed' || status.lessonStatus === 'failed';

                if (allTerminal && pipelineDone) {
                    resolve(status);
                    return;
                }

                // Continue polling
                setTimeout(poll, intervalMs);
            } catch (err) {
                reject(err);
            }
        };

        // Start first poll
        setTimeout(poll, 500);
    });

    return { promise, cancel };
}
