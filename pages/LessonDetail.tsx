import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  ChevronRight, Youtube, Sparkles, Layout,
  Archive, FileText, Loader2, Info, UploadCloud, Music,
  Database, Check, ClipboardList, Plus, X,
  Headphones, Book, Layers, ImageIcon, FileSearch, ArrowRight, Lightbulb, Zap,
  Trash2, AlertCircle, Target, Link as LinkIcon, Cpu, PenLine, ChevronDown
} from 'lucide-react';
import { Lesson, Source, AIResult } from '../types';
import { saveFile, deleteFile, getFile } from '../services/storage';
import { uploadHomeworkFile, deleteHomeworkFile, supabase, upsertLesson } from '../services/supabaseService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const base64ToFile = (base64Data: string, mimeType: string, fileName: string): File => {
  const byteCharacters = atob(base64Data);
  const byteArrays = [];
  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }
  return new File(byteArrays, fileName, { type: mimeType });
};

// Retry banner for partially failed analysis
const RetryBanner: React.FC<{ lessonId: string; supabase: any; onRetry: () => void }> = ({ lessonId, supabase, onRetry }) => {
  const [failedJobs, setFailedJobs] = useState<any[]>([]);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let isSubscribed = true;

    const check = async () => {
      const { data } = await supabase.from('processing_queue')
        .select('id, job_type, error_message')
        .eq('lesson_id', lessonId)
        .in('status', ['failed', 'dead']);
      if (isSubscribed && data) setFailedJobs(data);
    };

    check();

    // Subscribe to realtime changes so banner disappears if jobs are deleted (e.g. user deletes the file)
    const subscription = supabase.channel(`public:processing_queue:${lessonId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'processing_queue', filter: `lesson_id=eq.${lessonId}` }, check)
      .subscribe();

    return () => {
      isSubscribed = false;
      supabase.removeChannel(subscription);
    };
  }, [lessonId, supabase]);

  if (failedJobs.length === 0) return null;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      // Reset failed jobs to pending so they get re-processed
      for (const job of failedJobs) {
        await supabase.from('processing_queue').update({
          status: 'pending', attempt_count: 0, error_message: null,
          locked_by: null, locked_at: null, stage: 'pending_upload'
        }).eq('id', job.id);
      }
      setFailedJobs([]);
      onRetry(); // Re-trigger the analysis pipeline
    } catch (e) {
      console.error('Retry failed:', e);
    }
    setRetrying(false);
  };

  return (
    <div className="bg-amber-50 p-5 rounded-[2rem] border border-amber-200 flex flex-col gap-3 text-right">
      <div className="flex items-center gap-3 justify-end">
        <span className="text-sm font-black text-amber-800">
          ⚠️ لم تُحلل {failedJobs.length} أجزاء بنجاح
        </span>
        <AlertCircle size={20} className="text-amber-500" />
      </div>
      <p className="text-xs text-amber-700 font-bold">
        بعض المحاضرات تعذرت قراءتها. يمكنك إعادة المحاولة.
      </p>
      <button
        onClick={handleRetry}
        disabled={retrying}
        className="self-start px-6 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50 flex items-center gap-2"
      >
        {retrying ? <Loader2 size={14} className="animate-spin" /> : <span>🔄</span>}
        إعادة تحليل الأجزاء الفاشلة
      </button>
    </div>
  );
};

const LessonDetail: React.FC = () => {
  const { lessonId } = useParams<{ lessonId: string }>();
  const [searchParams] = useSearchParams();
  const subjectId = searchParams.get('subjectId');

  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'vault'>('feed');
  const [isProcessing, setIsProcessing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showYtModal, setShowYtModal] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});
  const [transientAIResult, setTransientAIResult] = useState<AIResult | null>(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [elapsedTime, setElapsedTime] = useState(0);

  const isExtractingRef = useRef(false);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Elapsed time counter during processing
  useEffect(() => {
    if (!isProcessing) { setElapsedTime(0); return; }
    const interval = setInterval(() => setElapsedTime(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  // ─── Auto-cleanup: حذف بيانات التحليل غير المكتملة عند تحميل الصفحة لتوفير المساحة ───
  useEffect(() => {
    const cleanupIncompleteAnalysis = async () => {
      if (!lessonId || !supabase) return;
      try {
        // Check if lesson has incomplete analysis (processing/pending but no result)
        const { data: lesson } = await supabase.from('lessons')
          .select('analysis_status, analysis_result').eq('id', lessonId).single();

        if (lesson && ['processing', 'pending'].includes(lesson.analysis_status) && !lesson.analysis_result) {
          // Check if there are actually any active jobs
          const { data: activeJobs } = await supabase.from('processing_queue')
            .select('id').eq('lesson_id', lessonId)
            .in('status', ['pending', 'processing']).limit(1);

          if (!activeJobs || activeJobs.length === 0) {
            // No active jobs and no result → stale data, clean it up
            console.log('[Cleanup] Found incomplete analysis with no active jobs. Cleaning up...');
            await Promise.allSettled([
              supabase.from('processing_queue').delete().eq('lesson_id', lessonId),
              supabase.from('document_sections').delete().eq('lesson_id', lessonId),
              supabase.from('file_hashes').delete().eq('lesson_id', lessonId),
            ]);
            await supabase.from('lessons').update({
              analysis_status: null, analysis_result: null
            }).eq('id', lessonId);
            console.log('[Cleanup] Done. Ready for fresh analysis.');
          }
        }
      } catch (e) {
        console.warn('[Cleanup] Auto-cleanup skipped:', e);
      }
    };
    cleanupIncompleteAnalysis();
  }, [lessonId]);

  useEffect(() => {
    const loadData = () => {
      try {
        if (!subjectId) {
          setError("لم يتم العثور على معرف المادة");
          setLoading(false);
          return;
        }
        const saved = localStorage.getItem(`mudhakara_lessons_${subjectId}`);
        if (saved) {
          const lessons: Lesson[] = JSON.parse(saved);
          const found = lessons.find(l => l.id === lessonId);
          if (found) setLesson(found);
        }
      } catch (err) {
        setError("فشل في تحميل بيانات الدرس");
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [lessonId, subjectId]);

  const updateLesson = async (newLesson: Lesson) => {
    setLesson(newLesson);
    try {
      if (supabase) {
        await upsertLesson(newLesson);
      }
      const key = `mudhakara_lessons_${subjectId}`;
      const saved = localStorage.getItem(key);
      let lessons: Lesson[] = saved ? JSON.parse(saved) : [];
      const index = lessons.findIndex(l => l.id === lessonId);
      if (index !== -1) lessons[index] = newLesson;
      else lessons.push(newLesson);
      localStorage.setItem(key, JSON.stringify(lessons));
    } catch (err) { console.error(err); }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'audio' | 'image' | 'document') => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (type === 'document') {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!isPdf) {
        setError('الملفات المدعومة للمستندات حاليًا: PDF فقط.');
        e.target.value = '';
        return;
      }
    }

    const sourceType: Source['type'] = type === 'document' ? 'pdf' : type;
    const reader = new FileReader();
    reader.onloadend = async () => {
      const content = reader.result as string;
      const fileId = `${sourceType}_${lessonId}_${Date.now()}`;
      await saveFile(fileId, content, file.name);
      const newSource: Source = { id: fileId, type: sourceType, name: file.name, content: "[Stored]" };
      if (lesson) updateLesson({ ...lesson, sources: [...lesson.sources, newSource] });
    };
    reader.readAsDataURL(file);
  };

  const handleAddYoutube = () => {
    if (!ytUrl.trim()) return;
    const newSource: Source = { id: `yt_${Date.now()}`, type: 'youtube', name: 'رابط يوتيوب', content: ytUrl.trim() };
    if (lesson) updateLesson({ ...lesson, sources: [...lesson.sources, newSource] });
    setYtUrl('');
    setShowYtModal(false);
  };

  const handleDeleteSource = async (id: string) => {
    await deleteFile(id);

    if (lesson) {
      const source = lesson.sources.find(s => s.id === id);

      if (source?.uploadedUrl) {
        // Delete the physical file from Supabase Storage to save space
        await deleteHomeworkFile(source.uploadedUrl);

        // Delete associated jobs and extracted sections from database
        if (supabase && lessonId) {
          const parts = source.uploadedUrl.split('/homework-uploads/');
          const storagePath = parts.length > 1 ? parts[1] : null;

          if (storagePath) {
            console.log(`[Cleanup] Deleting database records for file: ${storagePath}`);
            // Delete jobs for this specific file
            await supabase.from('processing_queue')
              .delete()
              .eq('lesson_id', lessonId)
              .filter('payload->>file_path', 'eq', storagePath);

            // Delete extracted text sections derived from this file
            await supabase.from('document_sections')
              .delete()
              .eq('lesson_id', lessonId)
              .eq('source_file_id', storagePath);

            // Removing the cache hash so if the user uploads the identical file again, it re-extracts
            await supabase.from('file_hashes')
              .delete()
              .eq('lesson_id', lessonId)
              .eq('file_path', storagePath);
          }
        }
      }

      updateLesson({ ...lesson, sources: lesson.sources.filter(s => s.id !== id) });
    }
  };

  const handleExtractMemory = async () => {
    if (!lesson) return;
    if (isExtractingRef.current) return;

    isExtractingRef.current = true;
    setIsProcessing(true);
    setProgressMsg('Starting analysis pipeline...');
    setError(null);

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Removed enqueueIngest in favor of inline batch fetch

    const triggerQueueWorker = async (concurrency = 1) => {
      // Fire N parallel Vercel invocations. Each processes 1 job within 10s limit.
      // This is safe because acquire_job uses SELECT...FOR UPDATE SKIP LOCKED,
      // so each worker claims a DIFFERENT job — no duplicates.
      const promises = Array.from({ length: concurrency }, (_, i) =>
        fetch(`/api/process-queue?t=${Date.now()}_${i}`, { method: 'POST' })
          .then(r => r.json().catch(() => ({})))
          .catch(() => ({ status: 'dispatched' }))
      );
      const results = await Promise.allSettled(promises);
      return results[0]?.status === 'fulfilled' ? (results[0] as any).value : { status: 'dispatched' };
    };

    const fetchJobStatus = async () => {
      const statusRes = await fetch(`/api/job-status?lessonId=${lesson.id}`);
      const statusPayload = await statusRes.json().catch(() => ({}));

      if (!statusRes.ok) {
        throw new Error(statusPayload?.error || `Status fetch failed (${statusRes.status})`);
      }

      return statusPayload;
    };

    try {
      const filesToIngest: { path: string; type: 'pdf' | 'audio' | 'image'; name: string; sourceId: string; contentHash?: string }[] = [];
      let updatedSources = [...lesson.sources];
      let hasUpdates = false;

      const inferType = (source: Source): 'pdf' | 'audio' | 'image' | null => {
        if (source.type === 'pdf' || source.type === 'document') return 'pdf';
        if (source.type === 'audio') return 'audio';
        if (source.type === 'image') return 'image';
        if (/\.(pdf)$/i.test(source.name)) return 'pdf';
        if (/\.(mp3|wav|m4a|mp4|ogg|webm)$/i.test(source.name)) return 'audio';
        if (/\.(jpg|jpeg|png|webp)$/i.test(source.name)) return 'image';
        return null;
      };

      const processSourceForIngest = async (source: Source, index: number) => {
        if (source.type === 'youtube') return;

        const normalizedType = inferType(source);
        if (!normalizedType) return;

        let storagePath = '';
        if (source.uploadedUrl && source.uploadedUrl.includes('/homework-uploads/')) {
          const parts = source.uploadedUrl.split('/homework-uploads/');
          if (parts.length > 1) {
            storagePath = parts[1];
          }
        }

        if (!storagePath) {
          setProgressMsg(`Uploading "${source.name}" to storage...`);
          let fileToUpload: File | null = null;

          const content = await getFile(source.id);
          if (content && content.startsWith('data:')) {
            const base64Data = content.split(',')[1];
            const mimeType = content.split(',')[0].split(':')[1].split(';')[0];
            fileToUpload = base64ToFile(base64Data, mimeType, source.name);
          }

          if (fileToUpload) {
            const publicUrl = await uploadHomeworkFile(fileToUpload);
            const parts = publicUrl.split('/homework-uploads/');
            if (parts.length > 1) storagePath = parts[1];
            updatedSources[index] = { ...source, uploadedUrl: publicUrl };
            hasUpdates = true;
          }
        }

        if (storagePath) {
          filesToIngest.push({
            path: storagePath,
            type: normalizedType,
            name: source.name,
            sourceId: source.id,
            contentHash: source.contentHash
          });
        }
      };

      // Force re-upload: clear uploadedUrl so files get re-uploaded from scratch
      for (let i = 0; i < lesson.sources.length; i++) {
        const src = { ...lesson.sources[i] };
        // Clear cached upload URL to force fresh upload from device storage
        if (src.uploadedUrl) {
          src.uploadedUrl = undefined as any;
          updatedSources[i] = src;
          hasUpdates = true;
        }
        await processSourceForIngest(src, i);
      }

      if (hasUpdates) {
        await updateLesson({ ...lesson, sources: updatedSources });
      }

      if (filesToIngest.length === 0) {
        throw new Error('No supported files found. Add PDF/audio/image first.');
      }

      const ingestFailures: string[] = [];
      let acceptedIngestCount = 0;
      const acceptedStatuses = new Set(['queued', 'duplicate', 'already_queued']);

      setProgressMsg(`Queueing ${filesToIngest.length} files...`);

      try {
        const response = await fetch('/api/ingest-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lessonId: lesson.id,
            files: filesToIngest.map(f => ({
              fileName: f.name,
              filePath: f.path,
              fileType: f.type,
              contentHash: f.contentHash
            })),
            forceReextract: true
          })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || `Batch ingest failed (${response.status})`);
        }

        if (Array.isArray(payload.results)) {
          for (const r of payload.results) {
            if (acceptedStatuses.has(r.status)) {
              acceptedIngestCount++;
            } else {
              ingestFailures.push(`${r.fileName}: ${r.message || r.status}`);
            }
          }
        } else {
          // Fallback if results array is missing but request succeeded
          acceptedIngestCount = filesToIngest.length;
        }
      } catch (err: any) {
        throw new Error(`Failed to enqueue files: ${err.message}`);
      }

      if (acceptedIngestCount === 0) {
        throw new Error(`All files failed to enqueue. ${ingestFailures.join(' | ')}`);
      }

      setProgressMsg('Triggering queue worker...');
      triggerQueueWorker(5).catch(console.warn);

      setProgressMsg('Processing queue and waiting for analysis...');
      let result: AIResult | null = null;
      const pollIntervalMs = 3000;  // Poll every 3s for faster feedback
      const queueKickEveryAttempts = 4; // Kick queue every ~12s to keep pipeline alive
      const maxPollAttempts = 10000; // Run essentially indefinitely for large files
      const maxConsecutiveStatusErrors = 10;
      let consecutiveStatusErrors = 0;
      const pollStartTime = Date.now();

      for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
        if (attempt === 1 || attempt % queueKickEveryAttempts === 0) {
          triggerQueueWorker(5).catch(console.warn);
        }

        let status: any;
        try {
          status = await fetchJobStatus();
          consecutiveStatusErrors = 0;
        } catch (statusErr: any) {
          consecutiveStatusErrors++;

          if (consecutiveStatusErrors >= maxConsecutiveStatusErrors) {
            throw statusErr;
          }

          setProgressMsg('Temporary connection issue while checking status. Retrying...');
          await delay(Math.min(pollIntervalMs * consecutiveStatusErrors, 15000));
          continue;
        }

        const jobs = Array.isArray(status?.jobs) ? status.jobs : [];
        const activeJobs = jobs.filter((job: any) => job.status === 'pending' || job.status === 'processing');
        const failedJobs = jobs.filter((job: any) => job.status === 'failed' || job.status === 'dead');

        let queueMsg = 'التحليل قيد الانتظار...';
        if (activeJobs.length > 0) {
          const processingJob = activeJobs.find((j: any) => j.status === 'processing') || activeJobs[0];

          // Determine the type from the payload we now reliably get
          const payloadType = processingJob.payload?.source_type || 'ملف';
          const typeMap: Record<string, string> = {
            'pdf': 'مستند PDF',
            'audio': 'مقطع صوتي',
            'image': 'صورة'
          };
          const readableType = typeMap[payloadType] || payloadType;

          // Map the new atomic job types to readable stages
          const jobStageMap: Record<string, string> = {
            'extract_pdf_info': 'استخراج صفحات المستند...',
            'ocr_page_batch': 'مسح ونقل النصوص للذاكرة...',
            'segment_lesson': 'استخراج الفهرس وتقسيم المحاضرات...',
            'transcribe_audio': 'تفريغ وفهم التسجيل الصوتي...',
            'analyze_lecture': 'توليد الملخص المعرفي...',
            'generate_quiz': 'إنشاء بنك الأسئلة والاختبارات...',
            'finalize_global_summary': 'ترتيب وتجميع الذاكرة...',

            // Legacy fallbacks
            'ingest_upload': 'جاري الرفع...',
            'extract_toc': 'قراءة الفهرس والدروس...',
            'build_lecture_segments': 'تجزئة الكتاب إلى محاضرات...',
            'extract_text_range': 'مسح النصوص...',
            'ocr_range': 'التعرف على الصور (OCR)...',
            'chunk_lecture': 'تحليل وتجزئة...',
            'embed_lecture': 'تحضير للبحث...',
            'ingest_extract': 'استخراج النص...',
            'ingest_chunk': 'تحليل وقاعدة البيانات...',
            'generate_book_overview': 'استنتاج النظرة العامة للكتاب...',
            'generate_analysis': 'توليد الملخص الذكي...'
          };

          const stageName = jobStageMap[processingJob.job_type] || processingJob.stage || 'قيد العمل';

          let progressStr = '';
          if (processingJob.progress && processingJob.progress > 0) {
            progressStr = ` (${processingJob.progress}%)`;
          }

          queueMsg = `[${readableType}] ${stageName}${progressStr}`;

          if (activeJobs.length > 1) {
            // Group other active jobs by unique path to avoid counting chained jobs as multiple parallel files visually
            const uniqueActiveFiles = new Set(activeJobs.map((j: any) => j.payload?.file_path).filter(Boolean));
            const remainingFiles = uniqueActiveFiles.size > 1 ? uniqueActiveFiles.size - 1 : 0;

            if (remainingFiles > 0) {
              queueMsg += ` (+${remainingFiles} ملفات بالانتظار)`;
            }
          }

          const totalJobsCount = jobs.length;
          const completedJobsCount = jobs.filter((j: any) => j.status === 'completed').length;

          if (totalJobsCount > 5) {
            const percent = Math.floor((completedJobsCount / totalJobsCount) * 100);
            queueMsg += ` — الإنجاز الكلي: ${percent}%`;
          }
        }

        // Add 10 minute safe background processing message
        const elapsedSinceStart = Date.now() - pollStartTime;
        if (elapsedSinceStart > 600000 && activeJobs.length > 0) { // 10 minutes
          queueMsg += ' (ما زالت المعالجة مستمرة بأمان في الخلفية ⏳)';
        }

        const ingestWarning = ingestFailures.length > 0 ? ` | تعذر معالجة ${ingestFailures.length} ملف` : '';
        setProgressMsg(queueMsg + ingestWarning);

        if (status?.lessonStatus === 'completed' && status?.analysisResult) {
          result = status.analysisResult;
          break;
        }

        // If no active jobs AND we have a result somewhere, we're done
        if (activeJobs.length === 0 && jobs.length > 0 && status?.analysisResult) {
          result = status.analysisResult;
          break;
        }

        // All jobs finished but no result — real failure (only after grace period)
        if (activeJobs.length === 0 && jobs.length > 0) {
          const allDone = jobs.every((j: any) => ['completed', 'failed', 'dead'].includes(j.status));
          const elapsed = Date.now() - pollStartTime;
          // Grace period: 120s (was 30s). Edge Functions can take minutes for Gemini calls.
          // Short grace periods cause false "خطأ غير معروف" errors.
          if (allDone && !status?.analysisResult && elapsed > 120000) {
            const failInfo = failedJobs.map((j: any) => `${j.job_type}: ${j.error_message || 'فشل'}`).join(' | ');
            throw new Error(`فشل التحليل: ${failInfo || 'خطأ غير معروف'}`);
          }
        }

        // Wait between poll iterations to avoid hammering the server
        await delay(pollIntervalMs);
      }

      if (!result) {
        throw new Error('Timed out waiting for analysis result');
      }

      const updatedLesson = { ...lesson, aiResult: result };
      await updateLesson(updatedLesson);
      setTransientAIResult(result);

      if (ingestFailures.length > 0) {
        setError(`Completed with skipped files: ${ingestFailures.join(' | ')}`);
      }

      setProgressMsg('Done. Analysis is ready.');
      setIsProcessing(false);

      setTimeout(() => {
        document.getElementById('ai-results-start')?.scrollIntoView({ behavior: 'smooth' });
      }, 300);

    } catch (err: any) {
      console.error('Deep Scan Error:', err);
      setError(err.message || 'Analysis failed');
      setIsProcessing(false);
    } finally {
      isExtractingRef.current = false;
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center min-h-screen text-indigo-600 bg-white">
      <Loader2 size={48} className="animate-spin mb-4" />
      <p className="font-black">جاري تحضير الذاكرة...</p>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-32 min-h-screen font-['Cairo'] bg-slate-50">
      <header className="flex flex-col md:flex-row items-start md:items-center justify-between mb-10 gap-4">
        <div className="flex items-center gap-4">
          <Link to={`/subject/${subjectId}`} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
            <ChevronRight size={24} className="text-slate-700" />
          </Link>
          <div className="text-right">
            <div className="flex items-center gap-2 mb-1 justify-end">
              <span className="text-[9px] font-black text-emerald-500 uppercase bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                <Cpu size={10} /> الذاكرة متصلة
              </span>
              <span className="text-[9px] font-black text-indigo-500 uppercase bg-indigo-50 px-2 py-0.5 rounded-full">التحليل الذكي</span>
            </div>
            <h1 className="text-2xl font-black text-slate-800">{lesson?.title || 'عنوان الدرس'}</h1>
          </div>
        </div>
        <div className="flex p-1.5 bg-slate-200 rounded-[1.8rem]">
          <button onClick={() => setActiveTab('feed')} className={`px-6 py-2.5 rounded-[1.4rem] text-sm font-bold transition-all ${activeTab === 'feed' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>تغذية الدرس</button>
          <button onClick={() => setActiveTab('vault')} className={`px-6 py-2.5 rounded-[1.4rem] text-sm font-bold transition-all ${activeTab === 'vault' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>المكتبة الذكية</button>
        </div>
      </header>

      {activeTab === 'feed' ? (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 text-right">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <button onClick={() => audioFileInputRef.current?.click()} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-indigo-50 transition-all">
              <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-3"><Headphones size={24} /></div>
              <h3 className="font-bold text-xs text-slate-900">رفع تسجيل</h3>
              <input type="file" ref={audioFileInputRef} accept="audio/*" className="hidden" onChange={(e) => handleFileUpload(e, 'audio')} />
            </button>
            <button onClick={() => imageFileInputRef.current?.click()} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-emerald-50 transition-all">
              <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-3"><ImageIcon size={24} /></div>
              <h3 className="font-bold text-xs text-slate-900">صور الدرس</h3>
              <input type="file" ref={imageFileInputRef} accept="image/*" className="hidden" onChange={(e) => handleFileUpload(e, 'image')} />
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-amber-50 transition-all">
              <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center mb-3"><FileSearch size={24} /></div>
              <h3 className="font-bold text-xs text-slate-900">ملف إضافي</h3>
              <input type="file" ref={fileInputRef} accept=".pdf,application/pdf" className="hidden" onChange={(e) => handleFileUpload(e, 'document')} />
            </button>
            <button onClick={() => setShowYtModal(true)} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-red-50 transition-all">
              <div className="w-12 h-12 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center mb-3"><Youtube size={24} /></div>
              <h3 className="font-bold text-xs text-slate-900">رابط يوتيوب</h3>
            </button>
          </div>

          <div className="bg-indigo-50 p-8 rounded-[2.5rem] border border-indigo-100 text-center flex flex-col items-center gap-4">
            <div className="p-4 bg-white rounded-2xl shadow-sm text-indigo-600 mb-2"><Layers size={32} /></div>
            <h2 className="text-xl font-black text-slate-800">تغذية الذاكرة</h2>
            <p className="text-xs text-slate-600 font-bold max-w-sm">ارفع مرفقات الدرس، وسيقوم المساعد الذكي بتحليل الصور والنصوص لإنشاء ملخصك.</p>
          </div>

          <button onClick={() => setActiveTab('vault')} className="w-full py-6 bg-slate-900 text-white rounded-[2.5rem] font-black flex items-center justify-center gap-4 hover:bg-indigo-600 transition-all shadow-xl">
            <span>الانتقال للمكتبة الذكية</span>
            <ArrowRight size={20} className="rotate-180" />
          </button>
        </div>
      ) : (
        <div className="space-y-12 animate-in fade-in duration-700 pb-32 text-right">

          <section className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
            <h2 className="text-sm font-black text-slate-800 mb-4 px-2">مكتبة الدرس ({lesson?.sources.length})</h2>
            <div className="space-y-2">
              {lesson?.sources.map(source => (
                <div key={source.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <button onClick={() => handleDeleteSource(source.id)} className="text-red-400 hover:text-red-600 p-2"><Trash2 size={16} /></button>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] font-bold text-slate-600 truncate max-w-[180px]">{source.name}</span>
                    {source.type === 'image' ? <ImageIcon size={18} className="text-emerald-500" /> : <FileText size={18} className="text-slate-400" />}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="flex flex-col items-center gap-4 py-12 bg-indigo-50/40 rounded-[4rem] text-center">
            <br />
            <div className="flex flex-col items-center gap-2 mb-8 w-full px-4">
              <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-indigo-100 shadow-sm">
                <Cpu size={18} className="text-indigo-500" />
                <span className="text-sm font-bold text-slate-700">تحليل عميق شامل — PDF + صوت + صور</span>
              </div>
            </div>

            <button
              disabled={isProcessing}
              onClick={handleExtractMemory}
              className={`px-16 py-7 rounded-full shadow-2xl font-black flex items-center gap-5 transition-all active:scale-95 group bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50`}
            >
              {isProcessing ? <Loader2 className="animate-spin" size={32} /> : <Sparkles size={36} />}
              <span className="text-2xl">استخراج من الذاكرة</span>
            </button>


            {isProcessing && (
              <div className="w-full max-w-lg mx-auto space-y-4 animate-in fade-in duration-500">
                {/* Overall progress bar */}
                <div className="bg-white p-5 rounded-[2rem] border border-indigo-100 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[11px] font-bold text-slate-400">منذ {Math.floor(elapsedTime / 60)}:{(elapsedTime % 60).toString().padStart(2, '0')}</span>
                    <div className="flex items-center gap-2">
                      <Loader2 size={16} className="animate-spin text-indigo-500" />
                      <span className="text-sm font-black text-indigo-600">جاري التحليل الذكي</span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden mb-3" dir="ltr">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: `${Math.max(2, (() => {
                          // Calculate progress from progressMsg
                          const match = progressMsg.match(/الإنجاز الكلي: (\d+)%/);
                          return match ? parseInt(match[1]) : 5;
                        })())}%`
                      }}
                    ></div>
                  </div>

                  {/* Current stage text */}
                  <p className="text-xs font-bold text-slate-600 text-right leading-relaxed">{progressMsg || 'جاري التجهيز...'}</p>
                </div>

                {/* Stage timeline */}
                <div className="bg-white p-5 rounded-[2rem] border border-slate-100 shadow-sm">
                  <h4 className="text-xs font-black text-slate-700 mb-4 text-right">مراحل التحليل</h4>
                  <div className="space-y-3" dir="rtl">
                    {[
                      { key: 'upload', icon: '📤', label: 'رفع الملفات', match: ['Uploading', 'Queueing', 'جاري الرفع', 'الرفع'] },
                      { key: 'ocr', icon: '🔍', label: 'استخراج النصوص (OCR)', match: ['OCR', 'الفهرس', 'تجزئة', 'مسح النصوص', 'التعرف'] },
                      { key: 'chunk', icon: '📑', label: 'تقطيع وتنظيم المحتوى', match: ['تحليل وتجزئة', 'تحليل وقاعدة', 'chunk'] },
                      { key: 'summary', icon: '📝', label: 'توليد الملخص التفصيلي', match: ['ملخص', 'توليد الملخص', 'summariz'] },
                      { key: 'quiz', icon: '❓', label: 'إنشاء الأسئلة والاختبارات', match: ['النظرة العامة', 'الملخص الذكي', 'generate'] },
                    ].map((stage) => {
                      const isActive = stage.match.some(m => progressMsg.toLowerCase().includes(m.toLowerCase()));
                      const stageOrder = ['upload', 'ocr', 'chunk', 'summary', 'quiz'];
                      const currentIdx = stageOrder.findIndex(s => {
                        const stg = [
                          { key: 'upload', match: ['Uploading', 'Queueing', 'جاري الرفع', 'الرفع'] },
                          { key: 'ocr', match: ['OCR', 'الفهرس', 'تجزئة', 'مسح النصوص', 'التعرف'] },
                          { key: 'chunk', match: ['تحليل وتجزئة', 'تحليل وقاعدة', 'chunk'] },
                          { key: 'summary', match: ['ملخص', 'توليد الملخص', 'summariz'] },
                          { key: 'quiz', match: ['النظرة العامة', 'الملخص الذكي', 'generate'] },
                        ].find(st => st.key === s);
                        return stg?.match.some(m => progressMsg.toLowerCase().includes(m.toLowerCase()));
                      });
                      const thisIdx = stageOrder.indexOf(stage.key);
                      const isDone = currentIdx > thisIdx;

                      return (
                        <div key={stage.key} className={`flex items-center gap-3 p-3 rounded-xl transition-all duration-300 ${isActive ? 'bg-indigo-50 border border-indigo-200' :
                          isDone ? 'bg-emerald-50/50' : 'opacity-40'
                          }`}>
                          <span className="text-lg">{isDone ? '✅' : stage.icon}</span>
                          <span className={`text-sm font-bold ${isActive ? 'text-indigo-700' : isDone ? 'text-emerald-700' : 'text-slate-500'
                            }`}>{stage.label}</span>
                          {isActive && <Loader2 size={14} className="animate-spin text-indigo-400 mr-auto" />}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Reassurance message for long processing */}
                {progressMsg.includes('⏳') && (
                  <div className="text-center p-3 bg-amber-50 rounded-2xl border border-amber-100">
                    <p className="text-xs font-bold text-amber-700">⏳ المعالجة مستمرة بأمان — لا تغلق الصفحة</p>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="mt-4 p-5 bg-red-50 border border-red-100 rounded-[1.5rem] flex items-center gap-3 text-red-600 max-w-md mx-auto">
                <AlertCircle size={24} className="shrink-0" />
                <p className="text-xs font-black">{error}</p>
              </div>
            )}
          </div>

          <div id="ai-results-start" className="scroll-mt-10"></div>

          {(transientAIResult || lesson?.aiResult) && (
            <div className="space-y-12 animate-in slide-in-from-bottom-8">
              {/* Retry banner for partially failed analysis */}
              {!isProcessing && supabase && lessonId && (
                <RetryBanner lessonId={lessonId} supabase={supabase} onRetry={handleExtractMemory} />
              )}
              {(transientAIResult?.focusPoints || lesson?.aiResult?.focusPoints) && (
                <section className="bg-white p-10 rounded-[3rem] border border-slate-100 shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-2 h-full bg-emerald-500"></div>
                  <h2 className="text-2xl font-black text-slate-800 mb-6 flex items-center justify-end gap-3">نقاط التركيز <Target className="text-emerald-500" /></h2>
                  <div className="space-y-6">
                    {(transientAIResult?.focusPoints || lesson?.aiResult?.focusPoints || []).map((fp, idx) => (
                      <div key={idx} className="p-6 bg-slate-50 rounded-2xl border border-slate-200 text-right">
                        <h3 className="font-bold text-lg text-slate-900 mb-2">{fp.title}</h3>
                        <p className="text-slate-600 text-sm leading-relaxed">{fp.details}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="space-y-6">
                <h2 className="text-2xl font-black text-slate-800 flex items-center justify-end gap-3">الملخص التفصيلي <Lightbulb className="text-amber-400" /></h2>

                {/* New structured lessons rendering */}
                {(() => {
                  const aiData = transientAIResult || lesson?.aiResult;
                  const lessons = aiData?.lessons;

                  // New JSON format: render each lesson as a card
                  if (lessons && lessons.length > 0) {
                    return lessons.map((lessonItem, idx) => (
                      <div key={idx} className="bg-white p-8 md:p-10 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden">
                        {/* Accent bar */}
                        <div className="absolute top-0 right-0 w-2 h-full bg-gradient-to-b from-indigo-500 to-purple-500"></div>

                        {/* Lesson number + title */}
                        <div className="flex items-center gap-3 mb-6 justify-end">
                          <h3 className="text-xl font-black text-slate-800">{lessonItem.lesson_title}</h3>
                          <span className="bg-indigo-100 text-indigo-700 text-xs font-black px-3 py-1.5 rounded-full">{idx + 1}</span>
                        </div>

                        {/* Detailed explanation (Markdown) */}
                        <div className="text-slate-700 leading-relaxed text-base font-medium mb-6">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              h1: ({ node, ...props }) => <h1 className="text-xl font-black text-indigo-700 mb-3 mt-5" {...props} />,
                              h2: ({ node, ...props }) => <h2 className="text-lg font-black text-indigo-600 mb-2 mt-4" {...props} />,
                              h3: ({ node, ...props }) => <h3 className="text-base font-bold text-indigo-500 mb-2 mt-3" {...props} />,
                              p: ({ node, ...props }) => <p className="mb-3 text-justify leading-relaxed" {...props} />,
                              ul: ({ node, ...props }) => <ul className="list-disc list-inside space-y-1.5 mb-3 pr-4" {...props} />,
                              ol: ({ node, ...props }) => <ol className="list-decimal list-inside space-y-1.5 mb-3 pr-4" {...props} />,
                              li: ({ node, ...props }) => <li className="text-slate-700 leading-relaxed" {...props} />,
                              strong: ({ node, ...props }) => <strong className="text-indigo-700 font-black" {...props} />,
                              blockquote: ({ node, ...props }) => <blockquote className="border-r-4 border-amber-400 pr-4 py-2 my-3 bg-amber-50 rounded-l-xl text-amber-800 italic" {...props} />,
                              table: ({ node, ...props }) => <div className="overflow-x-auto my-3"><table className="w-full border-collapse border border-slate-200 text-sm" {...props} /></div>,
                              th: ({ node, ...props }) => <th className="border border-slate-200 bg-slate-50 px-3 py-2 text-right font-bold" {...props} />,
                              td: ({ node, ...props }) => <td className="border border-slate-200 px-3 py-2 text-right" {...props} />,
                            }}
                          >
                            {lessonItem.detailed_explanation || ''}
                          </ReactMarkdown>
                        </div>

                        {/* Rules */}
                        {lessonItem.rules && lessonItem.rules.length > 0 && (
                          <div className="mb-6">
                            <h4 className="text-sm font-black text-emerald-700 mb-3 flex items-center gap-2 justify-end">
                              القواعد الأساسية
                              <div className="w-6 h-6 bg-emerald-100 rounded-lg flex items-center justify-center">📋</div>
                            </h4>
                            <div className="space-y-2">
                              {lessonItem.rules.map((rule, rIdx) => (
                                <div key={rIdx} className="flex items-start gap-3 p-3 bg-emerald-50/60 rounded-xl border border-emerald-100">
                                  <span className="text-sm text-slate-600 font-bold text-right flex-1">{rule}</span>
                                  <span className="bg-emerald-200 text-emerald-800 text-[10px] font-black w-6 h-6 rounded-full flex items-center justify-center shrink-0">{rIdx + 1}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Examples */}
                        {lessonItem.examples && lessonItem.examples.length > 0 && (
                          <div>
                            <h4 className="text-sm font-black text-amber-700 mb-3 flex items-center gap-2 justify-end">
                              أمثلة تطبيقية
                              <div className="w-6 h-6 bg-amber-100 rounded-lg flex items-center justify-center">💡</div>
                            </h4>
                            <div className="overflow-x-auto">
                              <table className="w-full text-sm border-collapse">
                                <thead>
                                  <tr className="bg-amber-50">
                                    <th className="text-right p-3 font-black text-amber-800 border-b border-amber-200">السبب / التوضيح</th>
                                    <th className="text-right p-3 font-black text-amber-800 border-b border-amber-200 w-32">الكلمة / المثال</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {lessonItem.examples.map((ex, eIdx) => (
                                    <tr key={eIdx} className={eIdx % 2 === 0 ? 'bg-white' : 'bg-amber-50/30'}>
                                      <td className="p-3 text-slate-600 font-medium border-b border-slate-100">{ex.reason}</td>
                                      <td className="p-3 font-bold text-indigo-700 border-b border-slate-100">{ex.word}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    ));
                  }

                  // Fallback: old markdown summary
                  return (
                    <div className="bg-white p-10 rounded-[3rem] border border-slate-100 shadow-sm relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-2 h-full bg-indigo-500"></div>
                      <div className="text-slate-700 leading-relaxed text-lg font-bold">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            h1: ({ node, ...props }) => <h1 className="text-2xl font-black text-indigo-700 mb-4 mt-6" {...props} />,
                            h2: ({ node, ...props }) => <h2 className="text-xl font-black text-indigo-600 mb-3 mt-5" {...props} />,
                            h3: ({ node, ...props }) => <h3 className="text-lg font-bold text-indigo-500 mb-2 mt-4" {...props} />,
                            p: ({ node, ...props }) => <p className="mb-4 text-justify" {...props} />,
                            ul: ({ node, ...props }) => <ul className="list-disc list-inside space-y-2 mb-4 pr-4" {...props} />,
                            ol: ({ node, ...props }) => <ol className="list-decimal list-inside space-y-2 mb-4 pr-4" {...props} />,
                            li: ({ node, ...props }) => <li className="text-slate-700" {...props} />,
                            strong: ({ node, ...props }) => <strong className="text-indigo-700 font-black" {...props} />,
                            blockquote: ({ node, ...props }) => <blockquote className="border-r-4 border-amber-400 pr-4 py-2 my-4 bg-amber-50 rounded-l-xl text-amber-800 italic" {...props} />,
                          }}
                        >
                          {aiData?.summary || ""}
                        </ReactMarkdown>
                      </div>
                    </div>
                  );
                })()}
              </section>

              {(transientAIResult?.quizzes || lesson?.aiResult?.quizzes) && (
                <section className="space-y-6">
                  <h2 className="text-2xl font-black text-slate-800 flex items-center justify-end gap-3">اختبار الفهم <ClipboardList className="text-emerald-500" /></h2>
                  {(transientAIResult?.quizzes || lesson?.aiResult?.quizzes || []).map((quiz, i) => (
                    <div key={i} className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
                      <p className="font-black text-lg text-slate-800 mb-6">{quiz.question}</p>
                      <div className="grid grid-cols-1 gap-3">
                        {quiz.options.map((opt, idx) => {
                          const userSelected = selectedAnswers[i];
                          const isCorrect = idx === quiz.correctAnswer;
                          let btnClass = "bg-slate-50 border-slate-100 text-slate-900";
                          if (userSelected !== undefined) {
                            if (isCorrect) btnClass = "bg-emerald-50 border-emerald-500 text-emerald-700 ring-2 ring-emerald-100";
                            else if (idx === userSelected) btnClass = "bg-red-50 border-red-500 text-red-700";
                            else btnClass = "opacity-50 bg-slate-50 text-slate-900";
                          }
                          return (
                            <button key={idx} disabled={userSelected !== undefined} onClick={() => setSelectedAnswers(p => ({ ...p, [i]: idx }))} className={`w-full p-4 rounded-2xl border text-right font-bold transition-all ${btnClass}`}>{opt}</button>
                          );
                        })}
                      </div>
                      {selectedAnswers[i] !== undefined && <p className="mt-4 p-4 bg-indigo-50 rounded-xl text-xs font-bold text-indigo-700 flex items-start gap-2"><Zap size={14} className="shrink-0" /> {quiz.explanation}</p>}
                    </div>
                  ))}
                </section>
              )}

              {(transientAIResult?.essayQuestions || lesson?.aiResult?.essayQuestions)?.length > 0 && (
                <section className="space-y-6">
                  <h2 className="text-2xl font-black text-slate-800 flex items-center justify-end gap-3">أسئلة مقالية <PenLine className="text-purple-500" /></h2>
                  {(transientAIResult?.essayQuestions || lesson?.aiResult?.essayQuestions || []).map((eq, i) => (
                    <div key={i} className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
                      <p className="font-black text-lg text-slate-800 mb-4">{eq.question}</p>
                      <details className="group">
                        <summary className="cursor-pointer flex items-center gap-2 text-purple-600 font-bold text-sm hover:text-purple-700 transition-colors">
                          <ChevronDown size={16} className="group-open:rotate-180 transition-transform" />
                          عرض الإجابة النموذجية
                        </summary>
                        <div className="mt-4 p-4 bg-purple-50 rounded-xl text-sm text-purple-800 leading-relaxed font-medium">{eq.idealAnswer}</div>
                      </details>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}
        </div>
      )
      }

      {/* YouTube Modal */}
      {
        showYtModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[150] p-4">
            <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl animate-in zoom-in text-right">
              <div className="flex justify-between items-center mb-6">
                <button onClick={() => setShowYtModal(false)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-black text-slate-800">إضافة فيديو</h2>
              </div>
              <input type="text" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} placeholder="رابط يوتيوب..." className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl mb-8 outline-none font-bold text-left" />
              <button onClick={handleAddYoutube} className="w-full bg-slate-900 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-indigo-600 transition-all">إضافة للمكتبة</button>
            </div>
          </div>
        )
      }
    </div >
  );
};

export default LessonDetail;
