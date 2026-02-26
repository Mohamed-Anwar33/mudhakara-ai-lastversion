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
import { uploadHomeworkFile, supabase, upsertLesson } from '../services/supabaseService';
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

  const isExtractingRef = useRef(false);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    const triggerQueueWorker = async (maxJobs = 1) => {
      const workerRes = await fetch(`/api/process-queue?maxJobs=${maxJobs}`, {
        method: 'POST'
      });
      const workerPayload = await workerRes.json().catch(() => ({}));

      // 504 is expected: Vercel times out but Edge Function continues in background.
      // Don't throw on 504 — the job is still running.
      if (!workerRes.ok && workerRes.status !== 504) {
        throw new Error(workerPayload?.error || `Queue worker failed (${workerRes.status})`);
      }

      return workerPayload;
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
      triggerQueueWorker(1).catch(console.warn);

      setProgressMsg('Processing queue and waiting for analysis...');
      let result: AIResult | null = null;
      const pollIntervalMs = 5000;  // Poll every 5s (was 3s) — reduces performance violations
      const queueKickEveryAttempts = 8; // Kick queue every ~40s (was 15s) — reduces 504 errors
      const maxPollAttempts = 10000; // Run essentially indefinitely for large files
      const maxConsecutiveStatusErrors = 10;
      let consecutiveStatusErrors = 0;
      const pollStartTime = Date.now();

      for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
        if (attempt === 1 || attempt % queueKickEveryAttempts === 0) {
          triggerQueueWorker(1).catch(console.warn);
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
            'ingest_upload': 'جاري الرفع...',
            'extract_toc': 'قراءة الفهرس والدروس...',
            'build_lecture_segments': 'تجزئة الكتاب إلى محاضرات...',
            'extract_text_range': 'مسح النصوص...',
            'ocr_range': 'التعرف على الصور (OCR)...',
            'chunk_lecture': 'تحليل وتجزئة...',
            'embed_lecture': 'تحضير للبحث...',
            'ingest_extract': 'استخراج النص...',
            'ingest_chunk': 'تحليل وقاعدة البيانات...',
            'analyze_lecture': 'توليد ملخص الدرس...',
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
            const failInfo = failedJobs.map((j: any) => j.job_type).join(', ');
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


            {isProcessing && <p className="text-sm font-black text-indigo-600 animate-pulse">{progressMsg || 'جاري التجهيز...'}</p>}

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

              <section className="bg-white p-10 rounded-[3rem] border border-slate-100 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 w-2 h-full bg-indigo-500"></div>
                <h2 className="text-2xl font-black text-slate-800 mb-6 flex items-center justify-end gap-3">الملخص <Lightbulb className="text-amber-400" /></h2>
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
                    {transientAIResult?.summary || lesson?.aiResult?.summary || ""}
                  </ReactMarkdown>
                </div>
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
