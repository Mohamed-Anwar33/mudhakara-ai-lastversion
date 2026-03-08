
import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  Plus, ChevronRight, FileText, Upload, Trash2, Book, Loader2, X,
  CheckCircle2, Sparkles, ClipboardList, Send, ArrowRight, Award,
  BookOpen, Search, FileUp, Info, AlertTriangle, MoreVertical, Edit2,
  UploadCloud, Check, Target, Headphones, ImageIcon, FileSearch, Youtube, Cpu, Layers
} from 'lucide-react';
import { Subject, Lesson, Source, Homework, ExamReviewResult, User, AnalyzedLesson, AIResult } from '../types.ts';
import { saveFile, getFile, deleteFile } from '../services/storage.ts';
import { analyzeHomeworkContent, generateExamReview, regenerateSection, analyzeLargeAudio } from '../services/geminiService.ts';
import { upsertLesson, removeLesson, uploadHomeworkFile, deleteHomeworkFile, supabase } from '../services/supabaseService.ts';
import { toast } from 'react-hot-toast';
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

interface SubjectDetailProps {
  subjects: Subject[];
  setSubjects: React.Dispatch<React.SetStateAction<Subject[]>>;
  user: User;
}

type TabType = 'lessons' | 'homeworks' | 'review';
type HwInputType = 'file' | 'text' | 'image' | 'audio';

const SubjectDetail: React.FC<SubjectDetailProps> = ({ subjects = [], setSubjects, user }) => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>('lessons');
  const [searchQuery, setSearchQuery] = useState('');

  const subject = subjects.find(s => s.id === id);

  useEffect(() => {
    if (!subject && subjects.length > 0) {
      navigate('/dashboard');
    }
  }, [subject, subjects, navigate]);

  const [lessons, setLessons] = useState<Lesson[]>(() => {
    try {
      const saved = localStorage.getItem(`mudhakara_lessons_${id}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const [homeworks, setHomeworks] = useState<Homework[]>(() => {
    try {
      const saved = localStorage.getItem(`mudhakara_homeworks_${id}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // ─── Subject Sources (uploaded files) ──────────────────────
  const [subjectSources, setSubjectSources] = useState<Source[]>(() => {
    try {
      const saved = localStorage.getItem(`mudhakara_subjectsources_${id}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // ─── Analyzed Lessons (AI-generated) ──────────────────────
  const [analyzedLessons, setAnalyzedLessons] = useState<AnalyzedLesson[]>(() => {
    try {
      const saved = localStorage.getItem(`mudhakara_analyzedlessons_${id}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [deletingLessonId, setDeletingLessonId] = useState<string | null>(null);
  const [lastTempLessonId, setLastTempLessonId] = useState<string | null>(() => {
    try { return localStorage.getItem(`mudhakara_lastlesson_${id}`) || null; } catch { return null; }
  });
  const [audioTranscriptData, setAudioTranscriptData] = useState<string>(() => {
    try { return localStorage.getItem(`mudhakara_audio_${id}`) || ''; } catch { return ''; }
  });
  const [reanalyzingIds, setReanalyzingIds] = useState<Set<string>>(new Set());
  const [reanalyzeElapsed, setReanalyzeElapsed] = useState(0);
  const [reanalyzeTotalCount, setReanalyzeTotalCount] = useState(0);

  // Timer for re-analysis progress
  useEffect(() => {
    if (reanalyzingIds.size > 0) {
      if (reanalyzeTotalCount === 0) setReanalyzeTotalCount(reanalyzingIds.size);
      const timer = setInterval(() => setReanalyzeElapsed(prev => prev + 1), 1000);
      return () => clearInterval(timer);
    } else {
      setReanalyzeElapsed(0);
      setReanalyzeTotalCount(0);
    }
  }, [reanalyzingIds.size]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [elapsedTime, setElapsedTime] = useState(0);
  const isExtractingRef = useRef(false);
  const [selectedLessonsForReview, setSelectedLessonsForReview] = useState<string[]>([]);
  const [examReviewResult, setExamReviewResult] = useState<ExamReviewResult | null>(null);

  // ─── Enhanced Review State ──────────────────────
  const [reviewProgress, setReviewProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [quizMode, setQuizMode] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
  const [quizRevealed, setQuizRevealed] = useState<Record<number, boolean>>({});
  const [hiddenEssays, setHiddenEssays] = useState<Record<number, boolean>>({});
  const [regenerating, setRegenerating] = useState<string | null>(null);

  // ─── File Upload Refs ──────────────────────
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showYtModal, setShowYtModal] = useState(false);
  const [ytUrl, setYtUrl] = useState('');

  const [showAddHomeworkModal, setShowAddHomeworkModal] = useState(false);
  const [hwInputMode, setHwInputMode] = useState<HwInputType>('image');
  const [showHomeworkResult, setShowHomeworkResult] = useState<Homework | null>(null);

  const [hwTitle, setHwTitle] = useState('');
  const [hwText, setHwText] = useState('');
  const [hwFile, setHwFile] = useState<{ name: string, content: string, type: string } | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [homeworkToDelete, setHomeworkToDelete] = useState<Homework | null>(null);
  const [showEditHomeworkModal, setShowEditHomeworkModal] = useState<Homework | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  // ─── Elapsed time counter ──────────────────────
  useEffect(() => {
    if (!isProcessing) { setElapsedTime(0); return; }
    const interval = setInterval(() => setElapsedTime(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  useEffect(() => {
    if (id) {
      localStorage.setItem(`mudhakara_lessons_${id}`, JSON.stringify(lessons));
      localStorage.setItem(`mudhakara_homeworks_${id}`, JSON.stringify(homeworks));
      localStorage.setItem(`mudhakara_subjectsources_${id}`, JSON.stringify(subjectSources));
      localStorage.setItem(`mudhakara_analyzedlessons_${id}`, JSON.stringify(analyzedLessons));
    }
  }, [lessons, homeworks, subjectSources, analyzedLessons, id]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ─── Auto-load audio transcript on mount ──────────────────────
  useEffect(() => {
    if (audioTranscriptData && audioTranscriptData.length > 50) return; // Already loaded
    if (!id) return;

    // Find lessonId from localStorage or database
    const tryLoadAudio = async () => {
      let lessonId = lastTempLessonId;
      if (!lessonId) {
        try {
          const { data: tempLessons } = await supabase.from('lessons')
            .select('id').eq('course_id', id)
            .like('lesson_title', '__analysis__%')
            .order('created_at', { ascending: false }).limit(1);
          if (tempLessons?.[0]) {
            lessonId = tempLessons[0].id;
            setLastTempLessonId(lessonId);
            try { localStorage.setItem(`mudhakara_lastlesson_${id}`, lessonId); } catch (_) { }
          }
        } catch (_) { }
      }
      if (!lessonId) return;

      // Check if this lesson has audio sources
      try {
        const { data: lesson } = await supabase.from('lessons')
          .select('sources').eq('id', lessonId).single();
        const hasAudio = (lesson?.sources || []).some((s: any) => s.type === 'audio');
        if (!hasAudio) return; // No audio file uploaded
      } catch (_) { return; }

      console.log('[Audio] Auto-loading transcript for lesson', lessonId);
      try {
        const res = await fetch('/api/fetch-audio-transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lessonId })
        });
        const data = await res.json();
        if (data.success && data.transcript && data.transcript.length > 50) {
          console.log(`[Audio] Loaded transcript (${data.transcript.length} chars, source: ${data.source})`);
          setAudioTranscriptData(data.transcript);
          try { localStorage.setItem(`mudhakara_audio_${id}`, data.transcript); } catch (_) { }
        }
      } catch (e) { console.warn('[Audio] Auto-load failed:', e); }
    };

    tryLoadAudio();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!subject) return null;

  // ─── File Upload Handler ──────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'audio' | 'image' | 'document') => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_FILE_SIZE_MB = 50;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
      toast.error(`عذراً، حجم الملف (${fileSizeMB} ميجابايت) يتجاوز الحد المسموح وهو ${MAX_FILE_SIZE_MB} ميجابايت.`, {
        duration: 8000, icon: '⚠️',
        style: { maxWidth: '500px', textAlign: 'right', direction: 'rtl', fontWeight: 'bold' }
      });
      e.target.value = '';
      return;
    }

    if (type === 'document') {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!isPdf) { toast.error('الملفات المدعومة حاليًا: PDF فقط.'); e.target.value = ''; return; }
    }

    let finalFile = file;
    if (type === 'image') {
      try {
        const toastId = toast.loading('جاري ضغط الصورة الذكي...');
        const imageCompression = (await import('browser-image-compression')).default;
        const compressedFile = await imageCompression(file, { maxSizeMB: 1, maxWidthOrHeight: 1920, useWebWorker: true });
        finalFile = new File([compressedFile], file.name, { type: compressedFile.type });
        toast.success(`تم ضغط الصورة 🪄`, { id: toastId });
      } catch { toast.dismiss(); }
    }

    const sourceType: Source['type'] = type === 'document' ? 'pdf' : type;

    // Audio files: upload directly to Supabase Storage (too large for IndexedDB base64)
    if (type === 'audio') {
      const toastId = toast.loading('جاري رفع التسجيل الصوتي للسحابة...');
      try {
        const publicUrl = await uploadHomeworkFile(finalFile);
        const fileId = `${sourceType}_${id}_${Date.now()}`;
        const newSource: Source = { id: fileId, type: sourceType, name: finalFile.name, content: "[Cloud]", uploadedUrl: publicUrl };
        setSubjectSources(prev => [...prev, newSource]);
        toast.success(`تم رفع "${finalFile.name}" بنجاح ✅`, { id: toastId });
      } catch (err: any) {
        toast.error(`فشل رفع الصوت: ${err.message || 'خطأ غير معروف'}`, { id: toastId });
      }
      e.target.value = '';
      return;
    }

    // PDF and images: store as base64 in IndexedDB
    const reader = new FileReader();
    reader.onloadend = async () => {
      const content = reader.result as string;
      const fileId = `${sourceType}_${id}_${Date.now()}`;
      await saveFile(fileId, content, finalFile.name);
      const newSource: Source = { id: fileId, type: sourceType, name: finalFile.name, content: "[Stored]" };
      setSubjectSources(prev => [...prev, newSource]);
      toast.success(`تم رفع "${finalFile.name}" بنجاح ✅`);
    };
    reader.readAsDataURL(finalFile);
    e.target.value = '';
  };

  const handleAddYoutube = () => {
    if (!ytUrl.trim()) return;
    const newSource: Source = { id: `yt_${Date.now()}`, type: 'youtube', name: 'رابط يوتيوب', content: ytUrl.trim() };
    setSubjectSources(prev => [...prev, newSource]);
    setYtUrl('');
    setShowYtModal(false);
    toast.success('تم إضافة رابط اليوتيوب ✅');
  };

  const handleDeleteSource = async (sourceId: string) => {
    await deleteFile(sourceId);
    const source = subjectSources.find(s => s.id === sourceId);
    if (source?.uploadedUrl) await deleteHomeworkFile(source.uploadedUrl);
    setSubjectSources(prev => prev.filter(s => s.id !== sourceId));
    toast.success('تم حذف الملف');
  };

  // ─── Delete Analyzed Lesson ──────────────────────
  const handleDeleteAnalyzedLesson = async (lessonId: string) => {
    setDeletingLessonId(lessonId);
    try {
      // Remove from state
      const updated = analyzedLessons.filter(al => al.id !== lessonId);
      setAnalyzedLessons(updated);
      localStorage.setItem(`mudhakara_analyzedlessons_${id}`, JSON.stringify(updated));

      // Clean up temp lesson from database
      try {
        const { data: tempLessons } = await supabase!.from('lessons')
          .select('id').eq('course_id', id)
          .like('lesson_title', '__analysis__%');
        if (tempLessons && tempLessons.length > 0 && updated.length === 0) {
          for (const tl of tempLessons) {
            await removeLesson(tl.id);
          }
        }
      } catch (e) { console.warn('Cleanup:', e); }

      toast.success('تم حذف الدرس بنجاح 🗑️', {
        icon: '✅',
        style: { direction: 'rtl' }
      });
    } catch (err: any) {
      toast.error('فشل حذف الدرس');
    } finally {
      setDeletingLessonId(null);
    }
  };

  // ─── Analysis Pipeline ──────────────────────
  const handleAnalyzeLessons = async () => {
    if (subjectSources.length === 0) return;
    if (isExtractingRef.current) return;
    isExtractingRef.current = true;
    setIsProcessing(true);
    setProgressMsg('جاري تجهيز الملفات...');

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const triggerQueueWorker = async (concurrency = 1) => {
      const promises = Array.from({ length: concurrency }, (_, i) =>
        fetch(`/api/process-queue?t=${Date.now()}_${i}`, { method: 'POST' })
          .then(r => r.json().catch(() => ({})))
          .catch(() => ({ status: 'dispatched' }))
      );
      await Promise.allSettled(promises);
    };

    // Create a temporary lesson for the pipeline
    const tempLessonId = crypto.randomUUID();
    setLastTempLessonId(tempLessonId);
    try { localStorage.setItem(`mudhakara_lastlesson_${id}`, tempLessonId); } catch (_) { }
    const tempLesson: Lesson = {
      id: tempLessonId, subjectId: id!, title: `__analysis__${Date.now()}`,
      createdAt: Date.now(), sources: [...subjectSources],
      requestType: 'study', user_id: user.id
    };

    try {
      await upsertLesson(tempLesson);
      setLessons(prev => [tempLesson, ...prev]);

      const filesToIngest: { path: string; type: 'pdf' | 'audio' | 'image'; name: string; sourceId: string; contentHash?: string }[] = [];
      let updatedSources = [...tempLesson.sources];
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

      for (let i = 0; i < tempLesson.sources.length; i++) {
        const source = { ...tempLesson.sources[i] };
        if (source.type === 'youtube') continue;
        const normalizedType = inferType(source);
        if (!normalizedType) continue;

        let storagePath = '';
        if (source.uploadedUrl?.includes('/homework-uploads/')) {
          const parts = source.uploadedUrl.split('/homework-uploads/');
          if (parts.length > 1) storagePath = parts[1];
        }

        if (!storagePath) {
          setProgressMsg(`جاري رفع "${source.name}" للسحابة...`);
          const content = await getFile(source.id);
          if (content && content.startsWith('data:')) {
            const base64Data = content.split(',')[1];
            const mimeType = content.split(',')[0].split(':')[1].split(';')[0];
            const fileToUpload = base64ToFile(base64Data, mimeType, source.name);
            const publicUrl = await uploadHomeworkFile(fileToUpload);
            const parts = publicUrl.split('/homework-uploads/');
            if (parts.length > 1) storagePath = parts[1];
            updatedSources[i] = { ...source, uploadedUrl: publicUrl };
            hasUpdates = true;
          }
        }

        if (storagePath) {
          filesToIngest.push({ path: storagePath, type: normalizedType, name: source.name, sourceId: source.id, contentHash: source.contentHash });
        }
      }

      if (hasUpdates) {
        const updatedTempLesson = { ...tempLesson, sources: updatedSources };
        await upsertLesson(updatedTempLesson);
      }

      if (filesToIngest.length === 0) throw new Error('لم يتم العثور على ملفات مدعومة. أضف PDF/صوت/صور أولاً.');

      setProgressMsg(`جاري إرسال ${filesToIngest.length} ملفات للتحليل...`);
      const response = await fetch('/api/ingest-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lessonId: tempLessonId,
          files: filesToIngest.map(f => ({ fileName: f.name, filePath: f.path, fileType: f.type, contentHash: f.contentHash })),
          forceReextract: true
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `فشل الإرسال (${response.status})`);

      setProgressMsg('بدأ التحليل الذكي...');
      triggerQueueWorker(1).catch(console.warn);

      // Poll for results — optimized for speed and API limits
      let result: AIResult | null = null;
      let currentPollIntervalMs = 2000; // Start with 2 seconds
      const maxPollIntervalMs = 8000;   // Cap at 8 seconds
      const pollStartTime = Date.now();
      let consecutiveNoJobs = 0;
      let autoRetryCount = 0;

      for (let attempt = 1; attempt <= 10000; attempt++) {
        // Only trigger queue worker aggressively at the start or if we know jobs exist
        if (attempt === 1 || consecutiveNoJobs < 3) {
          triggerQueueWorker(1).catch(console.warn);
        }

        let status: any;
        try {
          const statusRes = await fetch(`/api/job-status?lessonId=${tempLessonId}`);
          status = await statusRes.json().catch(() => ({}));
        } catch { await delay(currentPollIntervalMs); continue; }

        const jobs = Array.isArray(status?.jobs) ? status.jobs : [];
        const activeJobs = jobs.filter((j: any) => j.status === 'pending' || j.status === 'processing');
        const failedJobs = jobs.filter((j: any) => j.status === 'failed');

        // Exponential Backoff Logic: If no active jobs are found, slow down the polling
        if (activeJobs.length === 0 && !status?.analysisResult) {
          consecutiveNoJobs++;
          currentPollIntervalMs = Math.min(currentPollIntervalMs * 1.5, maxPollIntervalMs);
        } else {
          consecutiveNoJobs = 0;
          currentPollIntervalMs = 2000; // Reset if jobs are active
        }

        // Build progress message
        if (activeJobs.length > 0) {
          const pJob = activeJobs.find((j: any) => j.status === 'processing') || activeJobs[0];
          const stageMap: Record<string, string> = {
            'extract_pdf_info': 'استخراج صفحات المستند...',
            'ocr_page_batch': 'المسح البصري ونقل النصوص (OCR)...',
            'segment_lesson': 'استخراج الفهرس وتقسيم المحاضرات...',
            'transcribe_audio': 'تفريغ التسجيل الصوتي بالذكاء الاصطناعي...',
            'analyze_lecture': 'توليد الشرح المعرفي العميق...',
            'generate_quiz': 'إنشاء بنك الأسئلة والاختبارات...',
            'finalize_global_summary': 'ترتيب وتجميع الذاكرة...',
          };
          let qMsg = stageMap[pJob.job_type] || 'قيد العمل...';

          // Override with granular real-time progress updates from the backend (stored in error_message while processing)
          if (pJob.status === 'processing' && pJob.error_message) {
            qMsg = pJob.error_message;
          }

          const totalJobs = jobs.length;
          const completedJobs = jobs.filter((j: any) => j.status === 'completed').length;
          if (totalJobs > 2) qMsg += ` — الإنجاز الكلي: ${Math.floor((completedJobs / totalJobs) * 100)}%`;
          setProgressMsg(qMsg);
        }

        if (status?.lessonStatus === 'completed' && status?.analysisResult) { result = status.analysisResult; break; }
        if (activeJobs.length === 0 && jobs.length > 0 && status?.analysisResult) { result = status.analysisResult; break; }
        if (activeJobs.length === 0 && jobs.length > 0) {
          const allDone = jobs.every((j: any) => ['completed', 'failed', 'dead'].includes(j.status));
          if (allDone) {
            // If there are failed jobs, offer retry instead of full failure
            if (failedJobs.length > 0 && !status?.analysisResult) {
              const failInfo = failedJobs.map((j: any) => `${j.job_type}: ${j.error_message || 'فشل'}`).join(' | ');
              // Cap auto-retries to prevent infinite loops with permanently failed jobs
              if (!autoRetryCount) autoRetryCount = 0;
              if (autoRetryCount < 2) {
                autoRetryCount++;
                setProgressMsg(`فشلت ${failedJobs.length} مهام. جاري إعادة المحاولة تلقائياً (${autoRetryCount}/2)...`);
                try {
                  const retryRes = await fetch('/api/retry-failed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lessonId: tempLessonId })
                  });
                  const retryData = await retryRes.json().catch(() => ({}));
                  if (retryData.retriedCount > 0) {
                    toast('جاري إعادة تحليل المهام الفاشلة... 🔄', { icon: '🔁', style: { direction: 'rtl' } });
                    triggerQueueWorker(1).catch(console.warn);
                    continue; // Continue polling — retried jobs are now pending
                  }
                } catch (e) { console.warn('Auto-retry failed:', e); }
              }
              // If max retries reached or retry returned 0
              if (Date.now() - pollStartTime > 120000) {
                throw new Error(`فشل التحليل: ${failInfo}`);
              }
            } else if (!status?.analysisResult && Date.now() - pollStartTime > 120000) {
              throw new Error('فشل التحليل: خطأ غير معروف');
            }
          }
        }
        await delay(currentPollIntervalMs);
      }

      if (!result) throw new Error('انتهت المهلة في انتظار نتيجة التحليل');

      // ── Auto-retry failed quiz jobs before merging ──
      try {
        const { data: failedQuizJobs } = await supabase.from('processing_queue')
          .select('id').eq('lesson_id', tempLessonId)
          .eq('job_type', 'generate_quiz').eq('status', 'failed');
        if (failedQuizJobs && failedQuizJobs.length > 0) {
          setProgressMsg(`جاري إعادة توليد الأسئلة لـ ${failedQuizJobs.length} محاضرات...`);
          await fetch('/api/retry-failed', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lessonId: tempLessonId })
          });
          triggerQueueWorker(1).catch(console.warn);
          // Short poll for quiz retry completion
          for (let rp = 0; rp < 30; rp++) {
            await delay(3000);
            triggerQueueWorker(1).catch(console.warn);
            const { count: stillPending } = await supabase.from('processing_queue')
              .select('*', { count: 'exact', head: true })
              .eq('lesson_id', tempLessonId).eq('job_type', 'generate_quiz')
              .in('status', ['pending', 'processing']);
            if (!stillPending || stillPending === 0) break;
            setProgressMsg(`جاري إعادة الأسئلة... (${rp + 1}/30)`);
          }
        }
      } catch (e) { console.warn('[quiz-retry]', e); }

      // ── Fetch audio transcript from Storage bucket ──
      let audioTranscript = '';
      try {
        const { data: audioBlob } = await supabase.storage.from('audio_transcripts')
          .download(`audio_transcripts/${tempLessonId}/raw_transcript.txt`);
        if (audioBlob) {
          audioTranscript = await audioBlob.text();
          console.log(`[Audio] Found transcript from storage (${audioTranscript.length} chars)`);
        }
      } catch (e) {
        // Fallback: try document_sections table
        try {
          const { data: audioSections } = await supabase.from('document_sections')
            .select('content').eq('lesson_id', tempLessonId)
            .eq('source_type', 'audio').order('section_index', { ascending: true });
          if (audioSections && audioSections.length > 0) {
            audioTranscript = audioSections.map(s => s.content).join('\n\n');
          }
        } catch (_) { }
      }
      // Save audio for UI audio card
      if (audioTranscript) {
        setAudioTranscriptData(audioTranscript);
        try { localStorage.setItem(`mudhakara_audio_${id}`, audioTranscript); } catch (_) { }
      }

      // ── Fetch segmented lectures for enrichment ──
      try {
        const { data: segments } = await supabase.from('segmented_lectures')
          .select('title, summary_storage_path, status').eq('lesson_id', tempLessonId)
          .order('start_page', { ascending: true });

        if (segments && segments.length > 0) {
          const mergedLessons: any[] = [], mergedQuizzes: any[] = [], mergedFocus: any[] = [], mergedEssays: any[] = [];
          for (const seg of segments) {
            if (!seg.summary_storage_path) continue; // Skip segments without summaries (intro/cover pages)
            try {
              const { data: fileBlob } = await supabase.storage.from('analysis').download(seg.summary_storage_path);
              if (fileBlob) {
                const parsed = JSON.parse(await fileBlob.text());
                const explanation = parsed.explanation_notes || '';
                if (explanation.length > 20) {
                  mergedLessons.push({ lesson_title: parsed.title || seg.title || 'محاضرة', detailed_explanation: explanation, rules: parsed.key_definitions || [], examples: [], _focusPoints: parsed.focusPoints || [] });
                }
                if (parsed.quizzes) mergedQuizzes.push(...parsed.quizzes);
                if (parsed.focusPoints) mergedFocus.push(...parsed.focusPoints);
                if (parsed.essayQuestions) mergedEssays.push(...parsed.essayQuestions);
              }
            } catch (e) { console.warn('[Segment download]', seg.title, e); }
          }

          // ── Smart audio distribution using keyword matching ──
          if (audioTranscript && mergedLessons.length > 0) {
            const audioParagraphs = audioTranscript.split(/\n{2,}/).filter(p => p.trim().length > 30);
            const usedParagraphs = new Set<number>();

            mergedLessons.forEach((lesson) => {
              const titleWords = (lesson.lesson_title || '').split(/[\s:,،.]+/).filter((w: string) => w.length > 2);
              if (titleWords.length === 0) return;

              const matchedParagraphs: string[] = [];
              audioParagraphs.forEach((para, idx) => {
                if (usedParagraphs.has(idx)) return;
                const paraLower = para.toLowerCase();
                const matches = titleWords.filter((w: string) => paraLower.includes(w.toLowerCase()));
                if (matches.length >= 1) {
                  matchedParagraphs.push(para);
                  usedParagraphs.add(idx);
                }
              });

              if (matchedParagraphs.length > 0) {
                lesson.detailed_explanation += '\n\n---\n\n## 🎧 من التسجيل الصوتي\n\n' + matchedParagraphs.join('\n\n');
              }
            });

            const unmatchedAudio = audioParagraphs.filter((_, idx) => !usedParagraphs.has(idx));
            if (unmatchedAudio.length > 0 && mergedLessons.length > 0) {
              const generalAudio = unmatchedAudio.join('\n\n');
              if (generalAudio.length > 100) {
                mergedLessons[0].detailed_explanation += '\n\n---\n\n## 🎧 ملاحظات صوتية عامة\n\n' + generalAudio;
              }
            }
          }

          // Only override result.lessons if we got meaningful content from storage
          if (mergedLessons.length > 0) result.lessons = mergedLessons;
          if (mergedQuizzes.length > 0) result.quizzes = mergedQuizzes;
          if (mergedFocus.length > 0) result.focusPoints = mergedFocus;
          if (mergedEssays.length > 0) result.essayQuestions = mergedEssays;
        }
      } catch (err) { console.warn('[Segments skipped]', err); }

      // Convert AIResult into AnalyzedLesson cards
      const newAnalyzedLessons: AnalyzedLesson[] = [];
      if (result.lessons && result.lessons.length > 0) {
        result.lessons.forEach((lesson: any, idx) => {
          // Use per-lesson focusPoints if available, otherwise fall back to global
          const lessonFocus = lesson._focusPoints || result!.focusPoints || [];
          newAnalyzedLessons.push({
            id: crypto.randomUUID(),
            lessonTitle: lesson.lesson_title,
            summary: result!.summary || '',
            focusPoints: lessonFocus,
            quizzes: result!.quizzes?.filter((_, qi) => Math.floor(qi / Math.max(1, Math.ceil((result!.quizzes?.length || 0) / result!.lessons!.length))) === idx) || [],
            essayQuestions: result!.essayQuestions?.filter((_, qi) => Math.floor(qi / Math.max(1, Math.ceil((result!.essayQuestions?.length || 0) / result!.lessons!.length))) === idx) || [],
            detailedExplanation: lesson.detailed_explanation
          });
        });
      } else {
        // Single lesson fallback
        newAnalyzedLessons.push({
          id: crypto.randomUUID(),
          lessonTitle: subject.name,
          summary: result.summary || '',
          focusPoints: result.focusPoints || [],
          quizzes: result.quizzes || [],
          essayQuestions: result.essayQuestions || [],
          detailedExplanation: result.summary
        });
      }

      setAnalyzedLessons(newAnalyzedLessons);
      toast.success(`تم التحليل بنجاح! 🎉 تم استخراج ${newAnalyzedLessons.length} درس`);
    } catch (err: any) {
      console.error('Analysis Error:', err);
      toast.error(err.message || 'فشل التحليل');
    } finally {
      setIsProcessing(false);
      setProgressMsg('');
      isExtractingRef.current = false;
    }
  };

  // ── Detect weak lessons (insufficient content) ──
  const isWeakLesson = (al: AnalyzedLesson) => {
    if (!al.detailedExplanation) return true;
    if (al.detailedExplanation.includes('قصير جداً ولم يتم استخراج')) return true;
    if (al.detailedExplanation.length < 500 && al.quizzes.length === 0) return true;
    return false;
  };

  // ── Re-analyze a specific weak lesson ──
  const handleReanalyzeSingle = async (lessonIdx: number) => {
    const al = analyzedLessons[lessonIdx];
    if (!al) return;

    // Auto-detect lastTempLessonId if not set
    let lessonId = lastTempLessonId;
    if (!lessonId) {
      try {
        const { data: tempLessons } = await supabase.from('lessons')
          .select('id').eq('course_id', id)
          .like('lesson_title', '__analysis__%')
          .order('created_at', { ascending: false }).limit(1);
        if (tempLessons && tempLessons.length > 0) {
          lessonId = tempLessons[0].id;
          setLastTempLessonId(lessonId);
          try { localStorage.setItem(`mudhakara_lastlesson_${id}`, lessonId); } catch (_) { }
        }
      } catch (_) { }
    }
    if (!lessonId) {
      toast.error('لا يمكن إعادة التحليل — يرجى تحليل الدروس أولاً');
      return;
    }

    // Find the matching segment ID
    const { data: segments } = await supabase.from('segmented_lectures')
      .select('id, title').eq('lesson_id', lessonId).order('start_page', { ascending: true });

    const matchingSeg = segments?.find((s: any) =>
      s.title === al.lessonTitle ||
      s.title?.includes(al.lessonTitle?.split(':').pop()?.trim() || '___') ||
      al.lessonTitle?.includes(s.title)
    );

    if (!matchingSeg) {
      toast.error('لم يتم العثور على الدرس في قاعدة البيانات');
      return;
    }

    setReanalyzingIds(prev => new Set(prev).add(al.id));

    try {
      const res = await fetch('/api/reanalyze-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonId, lectureId: matchingSeg.id })
      });
      const result = await res.json();

      if (!res.ok || result.status === 'no_text' || result.charCount === 0 || !result.content?.explanation_notes) {
        return { success: false, title: al.lessonTitle };
      }

      // Atomic state update — uses callback to avoid stale closures in parallel execution
      setAnalyzedLessons(prev => {
        const updated = [...prev];
        updated[lessonIdx] = {
          ...updated[lessonIdx],
          detailedExplanation: result.content.explanation_notes,
          focusPoints: result.content.focusPoints || updated[lessonIdx].focusPoints,
        };
        localStorage.setItem(`mudhakara_analyzedlessons_${id}`, JSON.stringify(updated));
        return updated;
      });

      return { success: true, title: al.lessonTitle, charCount: result.charCount, elapsed: result.elapsed };
    } catch (err: any) {
      return { success: false, title: al.lessonTitle, error: err.message };
    } finally {
      setReanalyzingIds(prev => { const s = new Set(prev); s.delete(al.id); return s; });
    }
  };

  // ── Re-analyze ALL weak lessons in parallel ──
  const handleReanalyzeAllWeak = async () => {
    const weakIndices = analyzedLessons
      .map((al, idx) => ({ al, idx }))
      .filter(({ al }) => isWeakLesson(al));

    if (weakIndices.length === 0) return;

    toast.loading(`جاري إعادة تحليل ${weakIndices.length} درس بالتوازي...`, { id: 'reanalyze-all' });

    // Run all in parallel using Promise.allSettled
    const results = await Promise.allSettled(
      weakIndices.map(({ idx }) => handleReanalyzeSingle(idx))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    const failed = weakIndices.length - succeeded;

    if (failed === 0) {
      toast.success(`تم إعادة تحليل ${succeeded} درس بنجاح! 🎉`, { id: 'reanalyze-all' });
    } else {
      toast.error(`تم ${succeeded}/${weakIndices.length} — ${failed} فشل (مشكلة OCR)`, { id: 'reanalyze-all', duration: 6000 });
    }
  };

  const filteredLessons = lessons.filter(l => l.title.toLowerCase().includes(searchQuery.toLowerCase()));

  const handleAddHomework = async () => {
    if (!hwTitle.trim()) return;
    const newHw: Homework = {
      id: crypto.randomUUID(),
      subjectId: id!,
      title: hwTitle.trim(),
      description: hwText,
      createdAt: Date.now(),
      source: hwFile ? {
        id: `hw_${Date.now()}`,
        name: hwFile.name,
        type: hwFile.type as any,
        content: hwFile.content
      } : undefined
    };

    if (hwFile) {
      try {
        await saveFile(newHw.source!.id, hwFile.content, hwFile.name);
      } catch (e) { console.error("Failed to save HW file", e); }
    }

    setHomeworks([newHw, ...homeworks]);
    setHwTitle('');
    setHwText('');
    setHwFile(null);
    setShowAddHomeworkModal(false);
  };

  // hooks moved above early return (line ~82) to comply with Rules of Hooks

  const handleUpdateHomework = () => {
    if (!showEditHomeworkModal || !hwTitle.trim()) return;
    const updatedHw = {
      ...showEditHomeworkModal,
      title: hwTitle.trim(),
      description: hwText,
      // Preserve existing source unless replaced (logic not implemented for file replacement in edit for simplicity now, focusing on text/title)
    };
    setHomeworks(homeworks.map(h => h.id === updatedHw.id ? updatedHw : h));
    setShowEditHomeworkModal(null);
    toast.success("تم تحديث الواجب بنجاح");
  };

  const handleDeleteHomework = () => {
    if (!homeworkToDelete) return;
    setHomeworks(homeworks.filter(h => h.id !== homeworkToDelete.id));
    setHomeworkToDelete(null);
    toast.success("تم حذف الواجب بنجاح");
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 relative min-h-screen font-['Cairo'] pb-24">
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <Link to="/dashboard" className="p-2 hover:bg-slate-100 rounded-full transition-colors"><ChevronRight size={24} /></Link>
          <div className="text-right">
            <h1 className="text-2xl font-black text-slate-800">{subject.name}</h1>
            <p className="text-[10px] text-slate-400 font-bold tracking-widest uppercase">{subject.code}</p>
          </div>
        </div>
      </header>

      <div className="flex p-1.5 bg-slate-100 rounded-[2rem] mb-8 shadow-inner">
        {[
          { id: 'lessons', label: 'الدروس', icon: <BookOpen size={18} /> },
          { id: 'homeworks', label: 'الواجبات', icon: <ClipboardList size={18} /> },
          { id: 'review', label: 'المراجعة', icon: <Sparkles size={18} /> },
        ].map((tab) => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id as TabType); setSearchQuery(''); }} className={`flex-1 flex items-center justify-center gap-2 py-3.5 rounded-[1.5rem] font-bold text-xs transition-all ${activeTab === tab.id ? 'bg-white shadow-lg text-indigo-600' : 'text-slate-500'}`}>
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="animate-in fade-in duration-500">
        {activeTab === 'lessons' && (
          <section className="space-y-8">
            {/* ─── Upload Buttons ──────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <button onClick={() => audioFileInputRef.current?.click()} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-blue-50 hover:border-blue-200 transition-all group">
                <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform"><Headphones size={24} /></div>
                <h3 className="font-bold text-xs text-slate-900">رفع تسجيل</h3>
                <input type="file" ref={audioFileInputRef} accept="audio/*" className="hidden" onChange={(e) => handleFileUpload(e, 'audio')} />
              </button>
              <button onClick={() => imageFileInputRef.current?.click()} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-emerald-50 hover:border-emerald-200 transition-all group">
                <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform"><ImageIcon size={24} /></div>
                <h3 className="font-bold text-xs text-slate-900">صور الدرس</h3>
                <input type="file" ref={imageFileInputRef} accept="image/*" className="hidden" onChange={(e) => handleFileUpload(e, 'image')} />
              </button>
              <button onClick={() => fileInputRef.current?.click()} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-amber-50 hover:border-amber-200 transition-all group">
                <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform"><FileSearch size={24} /></div>
                <h3 className="font-bold text-xs text-slate-900">ملف إضافي</h3>
                <input type="file" ref={fileInputRef} accept=".pdf,application/pdf" className="hidden" onChange={(e) => handleFileUpload(e, 'document')} />
              </button>
              <button onClick={() => setShowYtModal(true)} className="bg-white p-6 rounded-[2.2rem] border border-slate-100 shadow-sm flex flex-col items-center hover:bg-red-50 hover:border-red-200 transition-all group">
                <div className="w-12 h-12 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform"><Youtube size={24} /></div>
                <h3 className="font-bold text-xs text-slate-900">رابط يوتيوب</h3>
              </button>
            </div>

            {/* ─── Uploaded Files List ──────────────────── */}
            {subjectSources.length > 0 && (
              <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
                <h3 className="text-sm font-black text-slate-800 mb-4 flex items-center justify-end gap-2">
                  الملفات المرفوعة ({subjectSources.length})
                  <Layers size={18} className="text-indigo-500" />
                </h3>
                <div className="space-y-2">
                  {subjectSources.map(source => (
                    <div key={source.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <button onClick={() => handleDeleteSource(source.id)} className="text-red-400 hover:text-red-600 p-2"><Trash2 size={16} /></button>
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] font-bold text-slate-600 truncate max-w-[200px]">{source.name}</span>
                        {source.type === 'image' ? <ImageIcon size={18} className="text-emerald-500" /> :
                          source.type === 'audio' ? <Headphones size={18} className="text-blue-500" /> :
                            source.type === 'youtube' ? <Youtube size={18} className="text-red-500" /> :
                              <FileText size={18} className="text-amber-500" />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ─── Analysis Button + Progress ──────────────────── */}
            {subjectSources.length > 0 && (
              <div className="flex flex-col items-center gap-4 py-8 bg-gradient-to-b from-indigo-50/50 to-transparent rounded-[3rem] text-center">
                <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-indigo-100 shadow-sm">
                  <Cpu size={18} className="text-indigo-500" />
                  <span className="text-sm font-bold text-slate-700">تحليل عميق شامل — PDF + صوت + صور</span>
                </div>
                <button disabled={isProcessing} onClick={handleAnalyzeLessons}
                  className="px-16 py-6 rounded-full shadow-2xl font-black flex items-center gap-4 transition-all active:scale-95 bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 text-xl">
                  {isProcessing ? <Loader2 className="animate-spin" size={28} /> : <Sparkles size={28} />}
                  <span>تحليل الدروس</span>
                </button>
                {isProcessing && (
                  <div className="w-full max-w-lg mx-auto space-y-3 animate-in fade-in duration-500 mt-4">
                    <div className="bg-white p-5 rounded-[2rem] border border-indigo-100 shadow-sm">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[11px] font-bold text-slate-400">منذ {Math.floor(elapsedTime / 60)}:{(elapsedTime % 60).toString().padStart(2, '0')}</span>
                        <div className="flex items-center gap-2">
                          <Loader2 size={16} className="animate-spin text-indigo-500" />
                          <span className="text-sm font-black text-indigo-600">جاري التحليل الذكي</span>
                        </div>
                      </div>
                      <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden mb-3" dir="ltr">
                        <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-700 ease-out"
                          style={{ width: `${Math.max(2, (() => { try { const m = progressMsg.match(/الإنجاز الكلي: (\d+)%/); return m ? parseInt(m[1]) : 5; } catch { return 5; } })())}%` }} />
                      </div>
                      <p className="text-xs font-bold text-slate-600 text-right leading-relaxed">{progressMsg || 'جاري التجهيز...'}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─── Analyzed Lesson Cards ──────────────────── */}
            {analyzedLessons.length > 0 && (
              <div>
                {/* ── Re-analysis Progress Banner ── */}
                {reanalyzingIds.size > 0 && (
                  <div className="mb-6 animate-in fade-in slide-in-from-top-4 duration-500">
                    <div className="bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 p-5 rounded-[2rem] border border-amber-200 shadow-sm">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="relative">
                            <div className="w-3 h-3 bg-amber-500 rounded-full animate-ping absolute"></div>
                            <div className="w-3 h-3 bg-amber-500 rounded-full relative"></div>
                          </div>
                          <span className="text-sm font-black text-amber-700">جاري إعادة تحليل {reanalyzingIds.size} درس</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] font-bold text-slate-400">منذ {Math.floor(reanalyzeElapsed / 60)}:{(reanalyzeElapsed % 60).toString().padStart(2, '0')}</span>
                          <span className="bg-amber-500 text-white text-[10px] font-black px-2.5 py-1 rounded-full">
                            {reanalyzeTotalCount > 0 ? Math.round(((reanalyzeTotalCount - reanalyzingIds.size) / reanalyzeTotalCount) * 100) : 0}%
                          </span>
                          <Loader2 size={18} className="animate-spin text-amber-500" />
                        </div>
                      </div>
                      <div className="w-full h-3 bg-amber-100 rounded-full overflow-hidden" dir="ltr">
                        <div className="h-full bg-gradient-to-r from-amber-400 to-orange-500 rounded-full transition-all duration-700 ease-out" style={{ width: `${reanalyzeTotalCount > 0 ? Math.max(5, Math.round(((reanalyzeTotalCount - reanalyzingIds.size) / reanalyzeTotalCount) * 100)) : 5}%` }} />
                      </div>
                      <div className="flex flex-wrap gap-2 mt-3 justify-end">
                        {analyzedLessons.filter(al => reanalyzingIds.has(al.id)).map(al => (
                          <span key={al.id} className="bg-white text-amber-700 text-[9px] font-black px-3 py-1 rounded-full border border-amber-200 flex items-center gap-1">
                            <Loader2 size={10} className="animate-spin" />
                            {al.lessonTitle}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between mb-6 px-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        setDeletingLessonId('__all__');
                        try {
                          setAnalyzedLessons([]);
                          localStorage.removeItem(`mudhakara_analyzedlessons_${id}`);
                          localStorage.removeItem(`mudhakara_audio_${id}`);
                          setAudioTranscriptData('');
                          try {
                            const { data: tempLessons } = await supabase!.from('lessons')
                              .select('id').eq('course_id', id)
                              .like('lesson_title', '__analysis__%');
                            if (tempLessons) {
                              for (const tl of tempLessons) await removeLesson(tl.id);
                            }
                          } catch (e) { console.warn('Cleanup:', e); }
                          toast.success('تم حذف جميع الدروس المستخرجة 🗑️', { icon: '✅', style: { direction: 'rtl' } });
                        } catch { toast.error('فشل الحذف'); }
                        finally { setDeletingLessonId(null); }
                      }}
                      disabled={deletingLessonId === '__all__'}
                      className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-500 rounded-2xl text-[10px] font-black border border-red-100 hover:bg-red-500 hover:text-white transition-all"
                    >
                      {deletingLessonId === '__all__' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      <span>حذف الكل</span>
                    </button>
                    {/* Re-analyze all weak lessons button */}
                    {analyzedLessons.some(isWeakLesson) && (
                      <button
                        onClick={handleReanalyzeAllWeak}
                        disabled={reanalyzingIds.size > 0}
                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-2xl text-[10px] font-black border-0 cursor-pointer hover:from-amber-600 hover:to-orange-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg"
                      >
                        {reanalyzingIds.size > 0 ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                        <span>
                          {reanalyzingIds.size > 0
                            ? `جاري التحليل (${reanalyzingIds.size})...`
                            : `🔄 إعادة تحليل ${analyzedLessons.filter(isWeakLesson).length} درس`}
                        </span>
                      </button>
                    )}
                  </div>
                  <h2 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    الدروس المستخرجة ({analyzedLessons.length})
                    <BookOpen size={20} className="text-indigo-500" />
                  </h2>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
                  {analyzedLessons.map((al, idx) => {
                    const weak = isWeakLesson(al);
                    const reanalyzing = reanalyzingIds.has(al.id);
                    return (
                      <div key={al.id} className="relative group">
                        <Link to={`/subject/${id}/analyzed/${idx}`}
                          className={`block bg-white p-6 rounded-[2.5rem] border text-center hover:shadow-xl transition-all shadow-sm ${weak ? 'border-amber-200 bg-amber-50/30' : 'border-slate-100 hover:border-indigo-200'}`}>
                          <div className={`w-14 h-14 rounded-[1.5rem] flex items-center justify-center mb-3 mx-auto group-hover:scale-110 transition-transform ${weak ? 'bg-gradient-to-br from-amber-50 to-orange-50 text-amber-500' : 'bg-gradient-to-br from-indigo-50 to-purple-50 text-indigo-500'}`}>
                            {weak ? <AlertTriangle size={28} /> : <BookOpen size={28} />}
                          </div>
                          <p className="text-xs font-black line-clamp-2 px-2 text-slate-700 mb-2">{al.lessonTitle}</p>
                          <div className="flex gap-1 justify-center flex-wrap">
                            {weak && <span className="bg-amber-100 text-amber-700 text-[9px] font-black px-2 py-0.5 rounded-full animate-pulse">⚠️ محتوى ناقص</span>}
                            {!weak && al.quizzes.length > 0 && <span className="bg-amber-50 text-amber-600 text-[9px] font-black px-2 py-0.5 rounded-full">{al.quizzes.length} سؤال</span>}
                            {!weak && al.focusPoints.length > 0 && <span className="bg-emerald-50 text-emerald-600 text-[9px] font-black px-2 py-0.5 rounded-full">{al.focusPoints.length} نقطة</span>}
                          </div>
                        </Link>
                        {/* Re-analyze button for weak lessons */}
                        {weak && (
                          <button
                            onClick={async (e) => {
                              e.preventDefault(); e.stopPropagation();
                              const tid = toast.loading(`جاري إعادة تحليل "${al.lessonTitle}"...`, { style: { direction: 'rtl' } });
                              const result = await handleReanalyzeSingle(idx);
                              if (result?.success) {
                                toast.success(`✅ "${al.lessonTitle}" — ${result.charCount} حرف`, { id: tid });
                              } else {
                                toast.error(`⚠️ فشل "${al.lessonTitle}" — مشكلة OCR`, { id: tid, duration: 5000 });
                              }
                            }}
                            disabled={reanalyzing}
                            className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-amber-500 text-white rounded-full text-[9px] font-black shadow-lg hover:bg-amber-600 transition-all z-20 flex items-center gap-1"
                          >
                            {reanalyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                            <span>{reanalyzing ? 'جاري...' : 'إعادة تحليل'}</span>
                          </button>
                        )}
                        {/* Delete button */}
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteAnalyzedLesson(al.id); }}
                          disabled={deletingLessonId === al.id}
                          className="absolute top-3 left-3 p-2 bg-red-50 rounded-full text-red-400 hover:text-white hover:bg-red-500 z-20 shadow-sm border border-red-100 transition-all"
                        >
                          {deletingLessonId === al.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </div>
                    );
                  })}

                  {/* ── Audio Focus Points Card (ما ركّز عليه المعلم) ── */}
                  {(() => {
                    const allAudioFocus = analyzedLessons.flatMap(al =>
                      (al.focusPoints || []).filter(fp => fp.title?.includes('🎙️') || fp.title?.includes('المعلم') || fp.details?.includes('🎙️'))
                    );

                    // Display the card unconditionally if we have at least one audio focus point.
                    if (allAudioFocus.length === 0) return null;

                    return (
                      <div className="col-span-2 sm:col-span-3">
                        <div className="bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 p-6 rounded-[2.5rem] border border-amber-200 shadow-sm transition-all hover:shadow-md">
                          <div className="flex items-center gap-3 mb-4 justify-end">
                            <div className="flex-1 text-right">
                              <h3 className="font-black text-base md:text-lg text-amber-800 flex items-center gap-2 justify-end">
                                ما قاله المعلم في الريكورد (النقاط الشاملة)
                                <Target size={20} className="text-amber-500" />
                              </h3>
                              <p className="text-[11px] md:text-xs text-amber-600/70 font-bold mt-1">
                                🎙️ تم استخراج جميع الملاحظات ({allAudioFocus.length} نقطة) من التسجيل الصوتي بالكامل
                              </p>
                            </div>
                            <div className="w-14 h-14 bg-gradient-to-br from-amber-400 to-orange-500 text-white rounded-[1.2rem] flex items-center justify-center shadow-lg flex-shrink-0">
                              <Headphones size={26} />
                            </div>
                          </div>
                          <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pl-1" dir="rtl">
                            {allAudioFocus.map((fp, i) => (
                              <div key={i} className="bg-white/70 backdrop-blur-sm rounded-2xl p-3 border border-amber-100 hover:border-amber-300 transition-all">
                                <div className="flex items-start gap-2">
                                  <span className="text-amber-500 mt-0.5 flex-shrink-0">🎙️</span>
                                  <div>
                                    <p className="text-[11px] font-black text-amber-900 mb-1">{fp.title?.replace(/🎙️\s*/g, '')}</p>
                                    <p className="text-[10px] text-slate-600 leading-relaxed line-clamp-3">{fp.details}</p>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Audio Recording Card ── */}
                  {audioTranscriptData && audioTranscriptData.length > 50 && (
                    <div className="relative group col-span-2 sm:col-span-3">
                      <div className="block bg-gradient-to-br from-blue-50 via-cyan-50 to-indigo-50 p-6 rounded-[2.5rem] border border-blue-200 shadow-sm hover:shadow-xl transition-all cursor-pointer"
                        onClick={() => {
                          const audioLesson: AnalyzedLesson = {
                            id: `audio_${id}`,
                            lessonTitle: '🎧 تفريغ التسجيل الصوتي',
                            summary: '',
                            focusPoints: [],
                            quizzes: [],
                            essayQuestions: [],
                            detailedExplanation: audioTranscriptData
                          };
                          const allLessons = [...analyzedLessons];
                          const existingIdx = allLessons.findIndex(l => l.id === `audio_${id}`);
                          if (existingIdx >= 0) {
                            allLessons[existingIdx] = audioLesson;
                          } else {
                            allLessons.push(audioLesson);
                          }
                          setAnalyzedLessons(allLessons);
                          localStorage.setItem(`mudhakara_analyzedlessons_${id}`, JSON.stringify(allLessons));
                          navigate(`/subject/${id}/analyzed/${existingIdx >= 0 ? existingIdx : allLessons.length - 1}`);
                        }}>
                        <div className="flex items-start gap-4 justify-end">
                          <div className="flex-1 text-right">
                            <h3 className="font-black text-base text-blue-800 mb-1 flex items-center gap-2 justify-end">
                              تفريغ التسجيل الصوتي
                              <Headphones size={22} className="text-blue-500" />
                            </h3>
                            <p className="text-[11px] text-blue-600/70 font-bold mb-2">
                              🎙️ ما قاله المعلم في التسجيل — {Math.round(audioTranscriptData.length / 1000)}k حرف
                            </p>
                            {/* Content preview */}
                            <div className="bg-white/60 backdrop-blur-sm rounded-2xl p-3 border border-blue-100 mb-2">
                              <p className="text-[10px] text-slate-600 leading-relaxed line-clamp-3 text-right" dir="rtl">
                                {audioTranscriptData.substring(0, 300).trim()}...
                              </p>
                            </div>
                            <div className="flex gap-1 mt-2 justify-end flex-wrap">
                              <span className="bg-blue-100 text-blue-700 text-[9px] font-black px-2 py-0.5 rounded-full">📝 نص كامل</span>
                              <span className="bg-cyan-100 text-cyan-700 text-[9px] font-black px-2 py-0.5 rounded-full">🎧 مفرّغ بالذكاء الاصطناعي</span>
                              <span className="bg-purple-100 text-purple-700 text-[9px] font-black px-2 py-0.5 rounded-full">🕐 من البداية للنهاية</span>
                            </div>
                          </div>
                          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-cyan-500 text-white rounded-[1.5rem] flex items-center justify-center group-hover:scale-110 transition-transform shadow-lg flex-shrink-0">
                            <Headphones size={32} />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ─── Empty State ──────────────────── */}
            {subjectSources.length === 0 && analyzedLessons.length === 0 && (
              <div className="text-center py-16 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm">
                <div className="w-16 h-16 bg-indigo-50 text-indigo-400 rounded-full flex items-center justify-center mx-auto mb-4"><Layers size={32} /></div>
                <h3 className="text-slate-800 font-bold mb-2">لا توجد ملفات مرفوعة</h3>
                <p className="text-slate-400 text-xs max-w-sm mx-auto">ارفع ملفات الدرس (تسجيل صوتي، صور، PDF، أو رابط يوتيوب) وسيقوم الذكاء الاصطناعي باستخراج الدروس تلقائياً.</p>
              </div>
            )}
          </section>
        )}
        {activeTab === 'homeworks' && (
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex justify-between items-center mb-6 px-2">
              <h2 className="text-lg font-black text-slate-800">الواجبات والمسائل</h2>
              <button onClick={() => setShowAddHomeworkModal(true)} className="bg-indigo-600 text-white px-5 py-2.5 rounded-2xl text-[10px] font-black shadow-lg flex items-center gap-2 hover:bg-indigo-700">
                <Plus size={16} /> إضافة واجب
              </button>
            </div>

            {homeworks.length === 0 ? (
              <div className="text-center py-16 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm">
                <div className="w-16 h-16 bg-indigo-50 text-indigo-400 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ClipboardList size={32} />
                </div>
                <h3 className="text-slate-800 font-bold mb-2">لا توجد واجبات مضافة</h3>
                <p className="text-slate-400 text-xs">أضف واجباتك المنزلية ليقوم المساعد الذكي بحلها وشرحها لك.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {homeworks.map(hw => (
                  <div key={hw.id} className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:border-indigo-100 transition-all">
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center">
                        <BookOpen size={20} />
                      </div>

                      <button
                        onClick={(e) => { e.stopPropagation(); setActiveMenuId(activeMenuId === hw.id ? null : hw.id); }}
                        className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-slate-50 rounded-full transition-colors relative"
                      >
                        <MoreVertical size={18} />
                        {activeMenuId === hw.id && (
                          <div ref={menuRef} className="absolute top-8 left-0 bg-white rounded-2xl shadow-xl border border-slate-100 py-2 z-[50] w-32 animate-in zoom-in duration-200">
                            <button onClick={(e) => {
                              e.stopPropagation();
                              setShowEditHomeworkModal(hw);
                              setHwTitle(hw.title);
                              setHwText(hw.description || '');
                              setActiveMenuId(null);
                            }} className="w-full px-4 py-2 text-right text-slate-600 hover:bg-slate-50 font-bold text-[10px] flex items-center justify-end gap-2">
                              <span>تعديل</span>
                              <Edit2 size={12} />
                            </button>
                            <button onClick={(e) => {
                              e.stopPropagation();
                              setHomeworkToDelete(hw);
                              setActiveMenuId(null);
                            }} className="w-full px-4 py-2 text-right text-red-500 hover:bg-red-50 font-bold text-[10px] flex items-center justify-end gap-2 border-t border-slate-50">
                              <span>حذف</span>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}
                      </button>
                      {hw.aiResult ? (
                        <span className="bg-emerald-50 text-emerald-600 text-[10px] font-black px-2 py-1 rounded-full flex items-center gap-1">
                          <CheckCircle2 size={12} /> تم الحل
                        </span>
                      ) : (
                        <span className="bg-amber-50 text-amber-600 text-[10px] font-black px-2 py-1 rounded-full flex items-center gap-1">
                          <Loader2 size={12} /> قيد الانتظار
                        </span>
                      )}
                    </div>
                    <h3 className="font-bold text-slate-800 mb-2">{hw.title}</h3>
                    <p className="text-xs text-slate-500 line-clamp-2 mb-4">{hw.description || "لا يوجد وصف"}</p>

                    <button onClick={async () => {
                      if (hw.aiResult) {
                        setShowHomeworkResult(hw);
                      } else if (hw.source || hw.description) {
                        setIsProcessing(true);
                        const toastId = toast.loading("جاري تحليل الواجب... يرجى الانتظار");
                        try {
                          let result;

                          // 🔍 Smart Routing Logic
                          const content = hw.source?.content || "";
                          const isLikelyUrl = content.length < 2000 && (content.startsWith('http') || content.startsWith('https'));
                          const isMediaType = ['audio', 'audio_url', 'video', 'video_url'].includes(hw.source?.type as string)
                            || ['.mp3', '.wav', '.m4a', '.mp4', '.mkv', '.mov'].some(ext => content.toLowerCase().includes(ext));

                          if (isLikelyUrl && isMediaType) {
                            // ✅ Path 1: Remote URL -> Use optimized pipeline
                            result = await analyzeLargeAudio(
                              content,
                              'audio/mp3',
                              (status) => toast.loading(status, { id: toastId })
                            );
                          } else if (isMediaType && content.length > 5000) {
                            // 🛑 Path 2: Large Base64 -> Block it
                            toast.error("الملف محفوظ كبيانات محلية كبيرة جداً. يرجى حذف الواجب وإعادة رفعه لضمان التحليل.", { id: toastId });
                            setIsProcessing(false);
                            return;
                          } else {
                            result = await analyzeHomeworkContent(
                              hw.title,
                              hw.description || "تحليل شامل",
                              hw.source, // Pass hw.source (Source | undefined) not hw (Homework)
                              undefined
                            );
                          }

                          // Update local state properly
                          const updatedHw = { ...hw, aiResult: result };
                          const updatedList = homeworks.map(h => h.id === hw.id ? updatedHw : h);
                          setHomeworks(updatedList);

                          toast.success("تم التحليل بذكاء! 🧠 النتائج جاهزة", { id: toastId });
                          setShowHomeworkResult({ ...hw, aiResult: result });

                        } catch (e: any) {
                          console.error(e);
                          toast.error(`فشل التحليل: ${e.message}`, { id: toastId });
                        } finally {
                          setIsProcessing(false);
                        }
                      }
                    }} className="w-full py-3 bg-slate-50 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                      {isProcessing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                      <span>{hw.aiResult ? "عرض الحل والشرح" : "حل الواجب بالذكاء الاصطناعي"}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === 'review' && (
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-indigo-900 rounded-[3rem] p-8 text-white mb-8 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-64 h-64 bg-indigo-600 rounded-full blur-[100px] opacity-50 -translate-x-1/2 -translate-y-1/2"></div>
              <div className="relative z-10">
                <h2 className="text-2xl font-black mb-4 flex items-center gap-3">
                  <Award className="text-amber-400" />
                  المراجع الذكي
                </h2>
                <p className="text-indigo-200 text-sm font-bold leading-relaxed max-w-lg mb-8">
                  استعد للاختبارات بثقة. اختر الدروس التي تريد مراجعتها، وسأقوم بإنشاء ملخص شامل، أسئلة متوقعة، واختبار تجريبي لك.
                </p>

                <div className="bg-white/10 backdrop-blur-md rounded-[2rem] p-6 border border-white/10">
                  <h3 className="font-bold text-sm mb-4">حدد دروس المراجعة:</h3>
                  <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-2 pl-2">
                    {(analyzedLessons.length > 0 ? analyzedLessons : lessons).map((item: any) => (
                      <label key={item.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl hover:bg-white/10 cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={selectedLessonsForReview.includes(item.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLessonsForReview([...selectedLessonsForReview, item.id]);
                            else setSelectedLessonsForReview(selectedLessonsForReview.filter((rid: string) => rid !== item.id));
                          }}
                          className="w-5 h-5 rounded-lg border-2 border-indigo-400 text-indigo-600 focus:ring-offset-0 focus:ring-0 bg-transparent"
                        />
                        <span className="text-xs font-bold">{item.lessonTitle || item.title}</span>
                      </label>
                    ))}
                    {analyzedLessons.length === 0 && lessons.length === 0 && (
                      <p className="text-indigo-300 text-xs text-center py-4">لا توجد دروس بعد. قم بتحليل الملفات أولاً.</p>
                    )}
                  </div>
                </div>

                <button
                  disabled={selectedLessonsForReview.length === 0 || isProcessing}
                  onClick={async () => {
                    setIsProcessing(true);
                    setReviewProgress(null);
                    setQuizMode(false);
                    setQuizAnswers({});
                    setQuizRevealed({});
                    setHiddenEssays({});
                    try {
                      // Bridge analyzedLessons → Lesson[] format for generateExamReview
                      let selected: Lesson[];
                      if (analyzedLessons.length > 0) {
                        selected = analyzedLessons
                          .filter(al => selectedLessonsForReview.includes(al.id))
                          .map(al => ({
                            id: al.id,
                            subjectId: id!,
                            title: al.lessonTitle,
                            createdAt: Date.now(),
                            sources: [],
                            requestType: 'study' as const,
                            aiResult: {
                              summary: al.summary || al.detailedExplanation || '',
                              focusPoints: al.focusPoints || [],
                              quizzes: al.quizzes || [],
                              essayQuestions: al.essayQuestions || [],
                            }
                          } as Lesson));
                      } else {
                        selected = lessons.filter(l => selectedLessonsForReview.includes(l.id));
                      }
                      if (selected.length === 0) {
                        toast.error('اختر درساً واحداً على الأقل');
                        setIsProcessing(false);
                        return;
                      }
                      const result = await generateExamReview(subject.name, selected, (step, total, label) => {
                        setReviewProgress({ step, total, label });
                      });
                      setExamReviewResult(result);
                      setReviewProgress(null);
                      toast.success("المراجعة الذكية جاهزة! 💪 ابدأ المذاكرة");
                    } catch (e: any) {
                      console.error(e);
                      toast.error(e.message || "حدث خطأ أثناء توليد المراجعة.");
                    } finally {
                      setIsProcessing(false);
                      setReviewProgress(null);
                    }
                  }}
                  className="mt-6 w-full py-4 bg-white text-indigo-900 rounded-2xl font-black text-sm hover:bg-indigo-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 shadow-xl"
                >
                  {isProcessing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  <span>ابدأ المراجعة الآن</span>
                </button>

                {/* ─── Progress Bar ──────────────────── */}
                {reviewProgress && (
                  <div className="mt-4 bg-white/10 backdrop-blur rounded-2xl p-4 border border-white/10">
                    <div className="flex items-center gap-3 mb-2">
                      <Loader2 size={16} className="animate-spin text-amber-400" />
                      <span className="text-xs font-bold text-white/90">{reviewProgress.label}</span>
                    </div>
                    <div className="w-full bg-white/10 rounded-full h-2">
                      <div className="bg-gradient-to-l from-amber-400 to-emerald-400 h-2 rounded-full transition-all duration-700" style={{ width: `${(reviewProgress.step / reviewProgress.total) * 100}%` }} />
                    </div>
                    <p className="text-[10px] text-indigo-300 mt-1 text-left">الخطوة {reviewProgress.step} من {reviewProgress.total}</p>
                  </div>
                )}
              </div>
            </div>

            {examReviewResult && (() => {
              const mcqCount = (examReviewResult.mcqs || []).length;
              const tfCount = ((examReviewResult as any).trueFalseQuestions || []).length;
              const essayCount = (examReviewResult.essayQuestions || []).length;
              const mockCount = (examReviewResult as any).mockExam?.questions?.length || 0;
              const totalQ = mcqCount + tfCount + essayCount + mockCount;

              const handleRegenerate = async (section: 'summary' | 'mcq' | 'essay' | 'mockExam') => {
                setRegenerating(section);
                try {
                  let selected: Lesson[];
                  if (analyzedLessons.length > 0) {
                    selected = analyzedLessons
                      .filter(al => selectedLessonsForReview.includes(al.id))
                      .map(al => ({
                        id: al.id, subjectId: id!, title: al.lessonTitle,
                        createdAt: Date.now(), sources: [], requestType: 'study' as const,
                        aiResult: { summary: al.summary || al.detailedExplanation || '', focusPoints: al.focusPoints || [], quizzes: al.quizzes || [], essayQuestions: al.essayQuestions || [] }
                      } as Lesson));
                  } else {
                    selected = lessons.filter(l => selectedLessonsForReview.includes(l.id));
                  }
                  const data = await regenerateSection(section, subject.name, selected);
                  if (!data) { toast.error('فشل إعادة التوليد'); return; }
                  setExamReviewResult(prev => {
                    if (!prev) return prev;
                    if (section === 'summary') return { ...prev, comprehensiveSummary: data.comprehensiveSummary, keyPoints: data.keyPoints };
                    if (section === 'mcq') return { ...prev, mcqs: data.mcqs, trueFalseQuestions: data.trueFalseQuestions };
                    if (section === 'essay') return { ...prev, essayQuestions: data.essayQuestions };
                    if (section === 'mockExam') return { ...prev, mockExam: data.mockExam };
                    return prev;
                  });
                  toast.success('تم إعادة التوليد بنجاح 🎯 المحتوى جديد');
                } catch (e: any) { toast.error(e.message || 'حدث خطأ'); }
                finally { setRegenerating(null); }
              };

              const quizScore = Object.entries(quizRevealed).filter(([k, v]) => {
                if (!v) return false;
                const idx = Number(k);
                const q = (examReviewResult.mcqs || [])[idx];
                return q && quizAnswers[idx] === q.correctAnswer;
              }).length;
              const quizTotal = Object.keys(quizRevealed).filter(k => quizRevealed[Number(k)]).length;

              return (
                <div className="space-y-8 animate-in slide-in-from-bottom-8">
                  {/* ─── Stats Bar ──────────────────── */}
                  <div className="bg-gradient-to-l from-indigo-50 to-emerald-50 p-5 rounded-[2rem] border border-indigo-100/50 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <Award className="text-amber-500" size={20} />
                      <span className="text-xs font-black text-slate-700">تم توليد {totalQ} سؤال من {selectedLessonsForReview.length} درس</span>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-[10px] font-black">{mcqCount} اختياري</span>
                      <span className="bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full text-[10px] font-black">{tfCount} صح/خطأ</span>
                      <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[10px] font-black">{essayCount} مقالي</span>
                      <span className="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-[10px] font-black">{mockCount} تجريبي</span>
                    </div>
                  </div>

                  {/* ─── Quiz Mode Toggle ──────────── */}
                  {mcqCount > 0 && (
                    <div className="flex items-center justify-between bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                      <span className="text-xs font-black text-slate-700 flex items-center gap-2">
                        <Target size={16} className="text-amber-500" />
                        وضع الاختبار التفاعلي
                      </span>
                      <button onClick={() => { setQuizMode(!quizMode); setQuizAnswers({}); setQuizRevealed({}); }} className={`px-4 py-2 rounded-xl text-[10px] font-black transition-all ${quizMode ? 'bg-amber-500 text-white shadow-lg' : 'bg-slate-100 text-slate-500'}`}>
                        {quizMode ? '✅ مفعّل — اضغط للإلغاء' : 'تفعيل وضع الاختبار'}
                      </button>
                    </div>
                  )}

                  {/* ─── Quiz Score ──────────────── */}
                  {quizMode && quizTotal > 0 && (
                    <div className="bg-gradient-to-l from-amber-50 to-emerald-50 p-4 rounded-2xl border border-amber-100/50 flex items-center justify-between">
                      <span className="text-xs font-black text-slate-700">📊 النتيجة الحالية</span>
                      <span className={`text-sm font-black ${quizScore / quizTotal >= 0.7 ? 'text-emerald-600' : quizScore / quizTotal >= 0.4 ? 'text-amber-600' : 'text-red-500'}`}>
                        {quizScore} / {quizTotal} ({Math.round((quizScore / quizTotal) * 100)}%)
                      </span>
                    </div>
                  )}

                  {/* ─── Summary ──────────────────── */}
                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm border-r-4 border-r-emerald-500 relative">
                    <div className="flex items-center justify-between mb-4">
                      <button onClick={() => handleRegenerate('summary')} disabled={!!regenerating} className="text-[10px] font-black text-indigo-500 hover:text-indigo-700 flex items-center gap-1 disabled:opacity-50">
                        {regenerating === 'summary' ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} إعادة توليد
                      </button>
                      <h3 className="font-black text-xl text-slate-800">الملخص الشامل</h3>
                    </div>
                    <div className="text-slate-600 leading-relaxed font-bold text-right" dangerouslySetInnerHTML={{ __html: (examReviewResult.comprehensiveSummary || "").replace(/\*\*(.*?)\*\*/g, '<b class="text-indigo-600">$1</b>') }} />
                    <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                      {(examReviewResult.keyPoints || []).map((point, idx) => (
                        <div key={idx} className="flex items-start gap-3 p-4 bg-slate-50 rounded-2xl">
                          <div className="w-6 h-6 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">{idx + 1}</div>
                          <p className="text-xs font-bold text-slate-700 pt-1">{point}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ─── MCQs ─────────────────────── */}
                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm border-r-4 border-r-amber-400">
                    <div className="flex items-center justify-between mb-6">
                      <button onClick={() => handleRegenerate('mcq')} disabled={!!regenerating} className="text-[10px] font-black text-indigo-500 hover:text-indigo-700 flex items-center gap-1 disabled:opacity-50">
                        {regenerating === 'mcq' ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} إعادة توليد
                      </button>
                      <h3 className="font-black text-xl text-slate-800 flex items-center gap-2">
                        <Target className="text-amber-500" />
                        أسئلة الاختيار من متعدد
                      </h3>
                    </div>
                    <div className="space-y-6">
                      {(examReviewResult.mcqs || []).map((q, i) => {
                        const isQuiz = quizMode;
                        const selected = quizAnswers[i];
                        const revealed = quizRevealed[i];
                        return (
                          <div key={i} className="bg-slate-50 p-6 rounded-[2rem] border border-slate-100">
                            <p className="font-black text-slate-800 mb-4 text-sm flex items-start gap-3">
                              <span className="bg-amber-100 text-amber-600 w-6 h-6 rounded-full flex items-center justify-center text-[10px] shrink-0 mt-0.5">{i + 1}</span>
                              {q.question}
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4 pr-9">
                              {q.options.map((opt, optIdx) => {
                                let cls = 'bg-white border-slate-100 text-slate-500 cursor-pointer hover:border-indigo-200';
                                if (isQuiz && selected === optIdx && !revealed) cls = 'bg-indigo-50 border-indigo-300 text-indigo-700 ring-2 ring-indigo-200';
                                if (isQuiz && revealed && optIdx === q.correctAnswer) cls = 'bg-emerald-50 border-emerald-200 text-emerald-700';
                                if (isQuiz && revealed && selected === optIdx && optIdx !== q.correctAnswer) cls = 'bg-red-50 border-red-200 text-red-600';
                                if (!isQuiz && optIdx === q.correctAnswer) cls = 'bg-emerald-50 border-emerald-200 text-emerald-700';
                                return (
                                  <button key={optIdx} onClick={() => { if (isQuiz && !revealed) setQuizAnswers(prev => ({ ...prev, [i]: optIdx })); }} className={`p-3 rounded-xl text-xs font-bold border text-right transition-all ${cls}`}>
                                    {opt}
                                    {(!isQuiz || revealed) && optIdx === q.correctAnswer && <CheckCircle2 size={14} className="inline-block mr-2 text-emerald-500" />}
                                  </button>
                                );
                              })}
                            </div>
                            {isQuiz && selected !== undefined && !revealed && (
                              <button onClick={() => setQuizRevealed(prev => ({ ...prev, [i]: true }))} className="text-xs font-black text-indigo-600 bg-indigo-50 px-4 py-2 rounded-xl hover:bg-indigo-100 transition-colors mr-9">كشف الإجابة</button>
                            )}
                            {(!isQuiz || revealed) && (
                              <div className="pr-9">
                                <p className="text-[10px] text-slate-400 font-bold bg-white/50 p-3 rounded-xl inline-block border border-slate-50">💡 {q.explanation}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* ─── Essay Questions ──────────── */}
                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
                    <div className="flex items-center justify-between mb-6">
                      <button onClick={() => handleRegenerate('essay')} disabled={!!regenerating} className="text-[10px] font-black text-indigo-500 hover:text-indigo-700 flex items-center gap-1 disabled:opacity-50">
                        {regenerating === 'essay' ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} إعادة توليد
                      </button>
                      <h3 className="font-black text-xl text-slate-800 flex items-center gap-2">
                        <AlertTriangle className="text-amber-500" />
                        الأسئلة المقالية المتوقعة
                      </h3>
                    </div>
                    <div className="space-y-4">
                      {(examReviewResult.essayQuestions || []).map((q, i) => (
                        <div key={i} className="p-6 bg-slate-50 rounded-[2rem]">
                          <p className="font-black text-slate-800 mb-3 text-sm">{q.question}</p>
                          {hiddenEssays[i] !== false && hiddenEssays[i] === undefined ? (
                            <button onClick={() => setHiddenEssays(prev => ({ ...prev, [i]: false }))} className="text-xs font-black text-indigo-600 bg-indigo-50 px-4 py-2 rounded-xl hover:bg-indigo-100 transition-colors flex items-center gap-2">
                              <BookOpen size={14} /> عرض الإجابة النموذجية
                            </button>
                          ) : (
                            <div className="p-4 bg-white rounded-2xl border border-slate-100 text-slate-500 text-xs leading-relaxed font-bold animate-in fade-in">
                              <div className="flex items-center justify-between mb-1">
                                <button onClick={() => setHiddenEssays(prev => ({ ...prev, [i]: undefined }))} className="text-[10px] text-slate-400 hover:text-slate-600">إخفاء</button>
                                <span className="text-indigo-500">الإجابة النموذجية:</span>
                              </div>
                              {q.idealAnswer}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ─── True/False ───────────────── */}
                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm border-l-4 border-l-indigo-500">
                    <h3 className="font-black text-xl text-slate-800 mb-6 flex items-center gap-2">
                      <CheckCircle2 className="text-indigo-500" />
                      أسئلة الصواب والخطأ
                    </h3>
                    <div className="grid gap-4">
                      {((examReviewResult as any).trueFalseQuestions || []).map((q: any, i: number) => (
                        <div key={i} className="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                          <div className="flex justify-between items-start">
                            <p className="font-bold text-slate-800 text-sm mb-3 flex-1">{q.question}</p>
                            <span className={`px-3 py-1 rounded-full text-[10px] font-black ${q.correctAnswer === 0 ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                              {q.options?.[q.correctAnswer] || (q.correctAnswer === 0 ? "صح" : "خطأ")}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-400 font-bold mt-2 border-t border-slate-200 pt-2">💡 {q.explanation}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </section>
        )}
      </div>

      {/* مودال إضافة رابط يوتيوب */}
      {showYtModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[200] p-4">
          <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl animate-in zoom-in text-right">
            <div className="flex justify-between items-center mb-6">
              <button onClick={() => setShowYtModal(false)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
              <h2 className="text-xl font-black text-slate-800">إضافة رابط يوتيوب</h2>
            </div>
            <input type="url" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." className="w-full p-5 bg-slate-100 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-red-400 transition-all mb-8" dir="ltr" />
            <button onClick={handleAddYoutube} className="w-full bg-red-600 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-red-700 transition-all flex items-center justify-center gap-2">
              <Youtube size={20} />
              <span>إضافة الرابط</span>
            </button>
          </div>
        </div>
      )}

      {/* مودال إضافة واجب */}
      {
        showAddHomeworkModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[200] p-4">
            <div className="bg-white w-full max-w-lg rounded-[2.5rem] p-8 md:p-10 shadow-2xl animate-in zoom-in text-right">
              <div className="flex justify-between items-center mb-6">
                <button onClick={() => setShowAddHomeworkModal(false)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-black text-slate-800">إضافة واجب منزلي</h2>
              </div>

              <div className="space-y-4 mb-8">
                <input type="text" value={hwTitle} onChange={(e) => setHwTitle(e.target.value)} placeholder="عنوان الواجب" className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-indigo-500 transition-all" />
                <textarea value={hwText} onChange={(e) => setHwText(e.target.value)} placeholder="وصف المسألة أو السؤال..." className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 h-24 resize-none focus:bg-white focus:border-indigo-500 transition-all" />

                <div className="flex gap-2 mb-4">
                  <button onClick={() => setHwInputMode('image')} className={`flex-1 py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${hwInputMode === 'image' ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-200' : 'bg-slate-50 text-slate-500'}`}>
                    <Upload size={16} /> صورة
                  </button>
                  <button onClick={() => setHwInputMode('text')} className={`flex-1 py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${hwInputMode === 'text' ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-200' : 'bg-slate-50 text-slate-500'}`}>
                    <FileText size={16} /> نص
                  </button>
                  <button onClick={() => setHwInputMode('audio')} className={`flex-1 py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${hwInputMode === 'audio' ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-200' : 'bg-slate-50 text-slate-500'}`}>
                    <Headphones size={16} /> تسجيل
                  </button>
                </div>

                {hwInputMode === 'image' && (
                  <label className="block w-full p-8 border-2 border-dashed border-slate-200 rounded-2xl text-center cursor-pointer hover:bg-slate-50 transition-colors">
                    {hwFile ? (
                      <div className="flex flex-col items-center gap-2 text-emerald-600">
                        <CheckCircle2 size={32} />
                        <span className="font-bold text-xs">{hwFile.name}</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-slate-400">
                        <UploadCloud size={32} />
                        <span className="font-bold text-xs">اضغط لرفع صورة المسألة</span>
                      </div>
                    )}
                    <input type="file" className="hidden" accept="image/*" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        try {
                          const toastId = toast.loading('جاري ضغط الصورة الذكي...');
                          const imageCompression = (await import('browser-image-compression')).default;
                          const options = { maxSizeMB: 1, maxWidthOrHeight: 1920, useWebWorker: true };
                          const compressedFile = await imageCompression(file, options);

                          const reader = new FileReader();
                          reader.onloadend = () => {
                            setHwFile({ name: file.name, content: reader.result as string, type: 'image' });
                            toast.success(`تم ضغط الصورة 🪄`, { id: toastId });
                          };
                          reader.readAsDataURL(compressedFile);
                        } catch (error) {
                          console.error("Compression err:", error);
                          // Fallback to original if compression fails
                          const reader = new FileReader();
                          reader.onloadend = () => {
                            setHwFile({ name: file.name, content: reader.result as string, type: 'image' });
                          };
                          reader.readAsDataURL(file);
                        }
                      }
                    }} />
                  </label>
                )}

                {hwInputMode === 'audio' && (
                  <label className="block w-full p-8 border-2 border-dashed border-slate-200 rounded-2xl text-center cursor-pointer hover:bg-slate-50 transition-colors">
                    {hwFile ? (
                      <div className="flex flex-col items-center gap-2 text-emerald-600">
                        <CheckCircle2 size={32} />
                        <span className="font-bold text-xs">{hwFile.name} (صوت)</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-slate-400">
                        <Headphones size={32} />
                        <span className="font-bold text-xs">اضغط لرفع التسجيل (صوت/فيديو)</span>
                        <span className="text-[10px] text-slate-300">MP3, M4A, WAV, MP4, MKV</span>
                      </div>
                    )}
                    <input type="file" className="hidden" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        // Validate file type manually (accept all audio/video formats)
                        const validExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma', '.mp4', '.mkv', '.mov', '.avi', '.mpeg', '.mpg', '.3gp'];
                        const fileName = file.name.toLowerCase();
                        const isValidFile = validExtensions.some(ext => fileName.endsWith(ext));

                        if (!isValidFile) {
                          toast.error("نوع الملف غير مدعوم. يرجى اختيار ملف صوت أو فيديو (MP3, MP4, WAV, إلخ)");
                          return;
                        }

                        // Smart File Size Validation
                        const MAX_FILE_SIZE_MB = 50;
                        const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
                        if (file.size > MAX_FILE_SIZE_BYTES) {
                          const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
                          toast.error(`عذراً، حجم الملف (${fileSizeMB} ميجابايت) يتجاوز الحد المسموح وهو ${MAX_FILE_SIZE_MB} ميجابايت.\nيرجى ضغط الملف قبل رفعه لتجنب مشاكل المعالجة.`, {
                            duration: 8000,
                            icon: '⚠️',
                            style: { maxWidth: '500px', textAlign: 'right', direction: 'rtl', fontWeight: 'bold' }
                          });
                          return;
                        }

                        const toastId = toast.loading("📡 جاري نقل التسجيل للسحابة الذكية... الذكاء الاصطناعي بيجهز للتحليل");
                        try {
                          const publicUrl = await uploadHomeworkFile(file);
                          setHwFile({ name: file.name, content: publicUrl, type: 'audio_url' });
                          toast.success("تم رفع التسجيل بنجاح! 🎧 جاهز للتفريغ", { id: toastId });
                        } catch (error) {
                          console.error(error);
                          toast.error("فشل الرفع — تأكد من حجم الملف واتصالك بالإنترنت", { id: toastId });
                        }
                      }
                    }} />
                  </label>
                )}
              </div>

              <button onClick={handleAddHomework} className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-indigo-700 transition-all">حفظ الواجب</button>
            </div>
          </div>
        )
      }

      {/* مودال تعديل واجب */}
      {
        showEditHomeworkModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[200] p-4">
            <div className="bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl animate-in zoom-in text-right">
              <div className="flex justify-between items-center mb-6">
                <button onClick={() => setShowEditHomeworkModal(null)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-black text-slate-800">تعديل الواجب</h2>
              </div>
              <div className="space-y-4 mb-8">
                <input type="text" value={hwTitle} onChange={(e) => setHwTitle(e.target.value)} className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900" />
                <textarea value={hwText} onChange={(e) => setHwText(e.target.value)} className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 h-24 resize-none" />
              </div>
              <button onClick={handleUpdateHomework} className="w-full bg-emerald-600 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-emerald-700 transition-all">حفظ التغييرات</button>
            </div>
          </div>
        )
      }

      {/* مودال حذف واجب */}
      {
        homeworkToDelete && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[210] p-4">
            <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-10 shadow-2xl text-center">
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-6"><Trash2 size={32} /></div>
              <h3 className="text-xl font-black text-slate-800 mb-2">حذف الواجب؟</h3>
              <p className="text-xs text-slate-500 mb-8 leading-relaxed">أنت على وشك حذف هذا الواجب. هل أنت متأكد؟</p>
              <div className="flex flex-col gap-3">
                <button onClick={handleDeleteHomework} className="w-full bg-red-500 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-red-600">حذف نهائي</button>
                <button onClick={() => setHomeworkToDelete(null)} className="w-full bg-slate-100 text-slate-500 font-black py-4 rounded-2xl hover:bg-slate-200">إلغاء</button>
              </div>
            </div>
          </div>
        )
      }

      {/* مودال عرض نتيجة الواجب */}
      {
        showHomeworkResult && showHomeworkResult.aiResult && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[250] p-4">
            <div className="bg-white w-full max-w-2xl rounded-[2.5rem] p-8 md:p-10 shadow-2xl animate-in zoom-in h-[85vh] flex flex-col">
              <div className="flex justify-between items-center mb-6 shrink-0">
                <button onClick={() => setShowHomeworkResult(null)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-black text-slate-800">نتيجة الحل</h2>
              </div>

              <div className="overflow-y-auto custom-scrollbar flex-1 pr-2 text-right space-y-8">
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-slate-500 font-bold text-xs mb-2">الإجابة النهائية</p>
                  <div className="prose prose-indigo max-w-none text-slate-700 leading-relaxed font-bold">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        table: ({ node, ...props }) => <table className="w-full text-right border-collapse border border-slate-200 my-4 rounded-xl overflow-hidden" {...props} />,
                        th: ({ node, ...props }) => <th className="bg-indigo-50 border border-slate-200 p-3 text-indigo-700 font-black text-xs" {...props} />,
                        td: ({ node, ...props }) => <td className="border border-slate-100 p-3 text-xs" {...props} />
                      }}
                    >
                      {showHomeworkResult.aiResult.finalAnswer}
                    </ReactMarkdown>
                  </div>
                </div>

                <div>
                  <h3 className="font-black text-slate-800 mb-4 text-sm flex items-center gap-2 justify-end">
                    خطوات الحل
                    <div className="w-6 h-6 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center"><Check size={14} /></div>
                  </h3>
                  <div className="space-y-4">
                    {showHomeworkResult.aiResult.solutionSteps?.map((step, idx) => (
                      <div key={idx} className="bg-white border border-slate-100 p-5 rounded-2xl shadow-sm">
                        <p className="font-bold text-slate-800 mb-2">{step.step}</p>
                        <p className="text-xs text-slate-500 leading-relaxed font-bold">{step.explanation}</p>
                      </div>
                    )) || <p className="text-xs text-slate-400 text-center">لا توجد خطوات حل إضافية.</p>}
                  </div>
                </div>

                {showHomeworkResult.aiResult.similarQuestions && (
                  <div>
                    <h3 className="font-black text-slate-800 mb-4 text-sm flex items-center gap-2 justify-end">
                      مسائل مشابهة للتدريب
                      <Sparkles className="text-amber-400" size={16} />
                    </h3>
                    <div className="grid gap-3">
                      {showHomeworkResult.aiResult.similarQuestions?.map((q, idx) => (
                        <div key={idx} className="bg-indigo-50/50 p-5 rounded-2xl border border-indigo-100/50">
                          <p className="font-bold text-slate-800 text-xs mb-2">س: {q.question}</p>
                          <p className="font-black text-indigo-600 text-xs">ج: {q.answer}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      }
    </div >
  );
};

export default SubjectDetail;
