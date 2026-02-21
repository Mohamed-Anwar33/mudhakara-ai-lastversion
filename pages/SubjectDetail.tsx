
import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  Plus, ChevronRight, FileText, Upload, Trash2, Book, Loader2, X,
  CheckCircle2, Sparkles, ClipboardList, Send, ArrowRight, Award,
  BookOpen, Search, FileUp, Info, AlertTriangle, MoreVertical, Edit2,
  UploadCloud, Check, Target, Headphones
} from 'lucide-react';
import { Subject, Lesson, Source, Homework, ExamReviewResult, User } from '../types.ts';
import { saveFile } from '../services/storage.ts';
import { analyzeHomeworkContent, generateExamReview, regenerateSection, analyzeLargeAudio } from '../services/geminiService.ts';
import { upsertLesson, removeLesson, uploadHomeworkFile } from '../services/supabaseService.ts';
import { toast } from 'react-hot-toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

  const [mainSource, setMainSource] = useState<Source | null>(() => {
    try {
      const saved = localStorage.getItem(`mudhakara_mainsource_${id}`);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedLessonsForReview, setSelectedLessonsForReview] = useState<string[]>([]);
  const [examReviewResult, setExamReviewResult] = useState<ExamReviewResult | null>(null);

  // ─── Enhanced Review State ──────────────────────
  const [reviewProgress, setReviewProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [quizMode, setQuizMode] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
  const [quizRevealed, setQuizRevealed] = useState<Record<number, boolean>>({});
  const [hiddenEssays, setHiddenEssays] = useState<Record<number, boolean>>({});
  const [regenerating, setRegenerating] = useState<string | null>(null);

  const [showAddLessonModal, setShowAddLessonModal] = useState(false);
  const [showEditLessonModal, setShowEditLessonModal] = useState<Lesson | null>(null);
  const [lessonToDelete, setLessonToDelete] = useState<Lesson | null>(null);

  const [showAddHomeworkModal, setShowAddHomeworkModal] = useState(false);
  const [hwInputMode, setHwInputMode] = useState<HwInputType>('image');
  const [showHomeworkResult, setShowHomeworkResult] = useState<Homework | null>(null);

  const [newLessonTitle, setNewLessonTitle] = useState('');
  const [editLessonTitle, setEditLessonTitle] = useState('');
  const [editLessonText, setEditLessonText] = useState('');

  const [hwTitle, setHwTitle] = useState('');
  const [hwText, setHwText] = useState('');
  const [hwFile, setHwFile] = useState<{ name: string, content: string, type: string } | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [homeworkToDelete, setHomeworkToDelete] = useState<Homework | null>(null);
  const [showEditHomeworkModal, setShowEditHomeworkModal] = useState<Homework | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id) {
      localStorage.setItem(`mudhakara_lessons_${id}`, JSON.stringify(lessons));
      localStorage.setItem(`mudhakara_homeworks_${id}`, JSON.stringify(homeworks));
      localStorage.setItem(`mudhakara_mainsource_${id}`, JSON.stringify(mainSource));
    }
  }, [lessons, homeworks, mainSource, id]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!subject) return null;

  const handleCreateLesson = async () => {
    if (!newLessonTitle.trim()) return;
    const newLesson: Lesson = {
      id: crypto.randomUUID(),
      subjectId: id!,
      title: newLessonTitle.trim(),
      createdAt: Date.now(),
      sources: [],
      requestType: 'study',
      user_id: user.id
    };
    try {
      await upsertLesson(newLesson);
      setLessons([newLesson, ...lessons]);
      setNewLessonTitle('');
      setShowAddLessonModal(false);
      toast.success("تم! الدرس جاهز للتغذية الذكية 🌟");
    } catch (e) { toast.error("لم نستطع حفظ الدرس — تأكد من اتصالك بالإنترنت"); }
  };

  const handleUpdateLesson = async () => {
    if (!showEditLessonModal || !editLessonTitle.trim()) return;
    const updatedLesson = {
      ...showEditLessonModal,
      title: editLessonTitle.trim(),
      studentText: editLessonText
    };
    try {
      await upsertLesson(updatedLesson);
      setLessons(lessons.map(l => l.id === updatedLesson.id ? updatedLesson : l));
      setShowEditLessonModal(null);
      toast.success("تم تحديث الدرس بنجاح ✨");
    } catch (e) { toast.error("فشل تحديث الدرس"); }
  };

  const handleDeleteLesson = async () => {
    if (!lessonToDelete) return;
    try {
      await removeLesson(lessonToDelete.id);
      setLessons(lessons.filter(l => l.id !== lessonToDelete.id));
      setLessonToDelete(null);
      toast.success("تم حذف الدرس بنجاح");
    } catch (e) { toast.error("لم نتمكن من الحذف — حاول مرة أخرى"); }
  };

  const handleMainSourceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) { // 10MB limit
        toast.error("الملف كبير جداً! الحد الأقصى 10MB — حاول ضغطه أولاً");
        return;
      }

      const reader = new FileReader();
      reader.onloadend = async () => {
        const fileId = `main_ref_${id}_${Date.now()}`;
        const content = reader.result as string;

        if (content.length > 20_000_000) {
          toast.error("محتوى الملف النصي طويل جداً.");
          return;
        }

        await saveFile(fileId, content, file.name);
        setMainSource({ id: fileId, name: file.name, type: 'pdf', content: "[Stored]" });
        toast.success("تم رفع المرجع بنجاح 📚 جاهز للتحليل");
      };
      reader.readAsDataURL(file);
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
        <div className="flex items-center gap-2">
          <label className={`cursor-pointer flex items-center gap-2 px-4 py-2 rounded-2xl border transition-all text-[10px] font-black ${mainSource ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-indigo-50 border-indigo-100 text-indigo-600 shadow-lg shadow-indigo-50'}`}>
            {mainSource ? <CheckCircle2 size={16} /> : <FileUp size={16} />}
            <span>{mainSource ? 'تغيير المرجع' : 'رفع المرجع'}</span>
            <input type="file" onChange={handleMainSourceUpload} className="hidden" accept=".pdf,.doc,.docx" />
          </label>
        </div>
      </header>

      {!mainSource && (
        <div className="mb-8 p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-center gap-3 text-amber-700 animate-pulse">
          <AlertTriangle size={20} />
          <p className="text-[11px] font-bold">يرجى رفع "الكتاب المرجعي" لضمان دقة تحليل الذكاء الاصطناعي.</p>
        </div>
      )}

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
          <section>
            <div className="relative mb-6">
              <Search className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
              <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="بحث في الدروس..." className="w-full bg-white border border-slate-100 rounded-[1.2rem] py-4 pr-12 pl-6 font-bold text-xs outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-right text-slate-900 placeholder:text-slate-400" />
            </div>
            <div className="flex justify-between items-center mb-6 px-2">
              <h2 className="text-lg font-black text-slate-800">الدروس المتاحة</h2>
              <button onClick={() => setShowAddLessonModal(true)} className="bg-indigo-600 text-white px-5 py-2.5 rounded-2xl text-[10px] font-black shadow-lg flex items-center gap-2 hover:bg-indigo-700">
                <Plus size={16} /> إضافة درس
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
              {filteredLessons.map((lesson) => (
                <div key={lesson.id} className="relative group">
                  <Link to={`/lesson/${lesson.id}?subjectId=${id}`} className="block bg-white p-6 rounded-[2.5rem] border border-slate-100 text-center flex flex-col items-center justify-center hover:shadow-xl hover:border-indigo-100 transition-all shadow-sm aspect-square">
                    <div className="w-14 h-14 bg-slate-50 text-slate-400 rounded-[1.5rem] flex items-center justify-center mb-3 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors">
                      <FileText size={28} />
                    </div>
                    <p className="text-xs font-black line-clamp-2 px-2 text-slate-700">{lesson.title}</p>
                  </Link>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveMenuId(activeMenuId === lesson.id ? null : lesson.id); }}
                    className="absolute top-4 left-4 p-2 bg-white/90 backdrop-blur rounded-full text-slate-300 hover:text-slate-600 z-20 shadow-sm border border-slate-50 transition-all"
                  >
                    <MoreVertical size={16} />
                  </button>
                  {activeMenuId === lesson.id && (
                    <div ref={menuRef} className="absolute top-12 left-4 bg-white rounded-2xl shadow-2xl border border-slate-100 py-2 z-[100] w-36 animate-in zoom-in duration-200">
                      <button onClick={(e) => {
                        e.stopPropagation();
                        setShowEditLessonModal(lesson);
                        setEditLessonTitle(lesson.title);
                        setEditLessonText(lesson.studentText || '');
                        setActiveMenuId(null);
                      }} className="w-full px-4 py-2.5 text-right text-slate-600 hover:bg-slate-50 font-bold text-xs flex items-center justify-end gap-2 transition-colors">
                        <span>تعديل الدرس</span>
                        <Edit2 size={14} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setLessonToDelete(lesson); setActiveMenuId(null); }} className="w-full px-4 py-2.5 text-right text-red-500 hover:bg-red-50 font-bold text-xs flex items-center justify-end gap-2 transition-colors border-t border-slate-50">
                        <span>حذف الدرس</span>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
                              mainSource ?? undefined
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
                    {lessons.map(lesson => (
                      <label key={lesson.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl hover:bg-white/10 cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={selectedLessonsForReview.includes(lesson.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLessonsForReview([...selectedLessonsForReview, lesson.id]);
                            else setSelectedLessonsForReview(selectedLessonsForReview.filter(id => id !== lesson.id));
                          }}
                          className="w-5 h-5 rounded-lg border-2 border-indigo-400 text-indigo-600 focus:ring-offset-0 focus:ring-0 bg-transparent"
                        />
                        <span className="text-xs font-bold">{lesson.title}</span>
                      </label>
                    ))}
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
                      const selected = lessons.filter(l => selectedLessonsForReview.includes(l.id));
                      const hasContent = selected.some(l => l.sources.length > 0 || (l.studentText && l.studentText.trim().length > 10));
                      if (!hasContent) {
                        toast.error(`الدروس المحددة فارغة`, { duration: 5000 });
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
                  const selected = lessons.filter(l => selectedLessonsForReview.includes(l.id));
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

      {/* مودال إضافة درس */}
      {
        showAddLessonModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[200] p-4">
            <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl animate-in zoom-in text-right">
              <div className="flex justify-between items-center mb-6">
                <button onClick={() => setShowAddLessonModal(false)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-black text-slate-800">درس جديد</h2>
              </div>
              <input type="text" value={newLessonTitle} onChange={(e) => setNewLessonTitle(e.target.value)} placeholder="مثال: مدخل إلى الذكاء الاصطناعي" className="w-full p-5 bg-slate-100 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-indigo-500 transition-all mb-8" />
              <button onClick={handleCreateLesson} className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-indigo-700 transition-all">إنشاء</button>
            </div>
          </div>
        )
      }

      {/* مودال تعديل درس */}
      {
        showEditLessonModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[200] p-4">
            <div className="bg-white w-full max-w-lg rounded-[2.5rem] p-8 md:p-10 shadow-2xl animate-in zoom-in text-right">
              <div className="flex justify-between items-center mb-6">
                <button onClick={() => setShowEditLessonModal(null)} className="p-2 text-slate-300 hover:bg-slate-50 rounded-full transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-black text-slate-800">تعديل بيانات الدرس</h2>
              </div>
              <div className="space-y-6 mb-8">
                <div>
                  <label className="block text-[10px] font-black text-slate-400 mb-2 mr-2">عنوان الدرس</label>
                  <input type="text" value={editLessonTitle} onChange={(e) => setEditLessonTitle(e.target.value)} className="w-full p-4 bg-slate-100 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-indigo-500 transition-all" />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-400 mb-2 mr-2">ملاحظات أو روابط إضافية</label>
                  <textarea value={editLessonText} onChange={(e) => setEditLessonText(e.target.value)} placeholder="أضف ملاحظاتك أو محتوى نصي..." className="w-full p-4 bg-slate-100 border border-slate-100 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 h-32 resize-none focus:bg-white focus:border-indigo-500 transition-all" />
                </div>
              </div>
              <button onClick={handleUpdateLesson} className="w-full bg-emerald-600 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-emerald-700 transition-all">حفظ التغييرات</button>
            </div>
          </div>
        )
      }

      {/* مودال حذف درس */}
      {
        lessonToDelete && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[210] p-4">
            <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-10 shadow-2xl text-center">
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-6"><Trash2 size={32} /></div>
              <h3 className="text-xl font-black text-slate-800 mb-2">حذف الدرس؟</h3>
              <p className="text-xs text-slate-500 mb-8 leading-relaxed">أنت على وشك حذف درس "{lessonToDelete.title}". لن تتمكن من استعادة البيانات المرتبطة بهذا الدرس.</p>
              <div className="flex flex-col gap-3">
                <button onClick={handleDeleteLesson} className="w-full bg-red-500 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-red-600">حذف نهائي</button>
                <button onClick={() => setLessonToDelete(null)} className="w-full bg-slate-100 text-slate-500 font-black py-4 rounded-2xl hover:bg-slate-200">إلغاء</button>
              </div>
            </div>
          </div>
        )
      }

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
                    <input type="file" className="hidden" accept="image/*" onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setHwFile({ name: file.name, content: reader.result as string, type: 'image' });
                        };
                        reader.readAsDataURL(file);
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

                        if (file.size > 100 * 1024 * 1024) {
                          toast.error("عذراً، حجم التسجيل كبير جداً (أكثر من 100 ميجا). يرجى ضغط الملف.");
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
