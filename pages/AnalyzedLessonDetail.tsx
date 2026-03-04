
import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
    ChevronRight, BookOpen, Target, Lightbulb, HelpCircle, CheckCircle2,
    X, ChevronDown, ChevronUp, FileText, Sparkles
} from 'lucide-react';
import { Subject, AnalyzedLesson, Quiz, EssayQuestion, FocusPoint } from '../types.ts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AnalyzedLessonDetailProps {
    subjects: Subject[];
}

const AnalyzedLessonDetail: React.FC<AnalyzedLessonDetailProps> = ({ subjects }) => {
    const { id, lessonIndex } = useParams<{ id: string; lessonIndex: string }>();
    const navigate = useNavigate();
    const idx = parseInt(lessonIndex || '0', 10);

    const subject = subjects.find(s => s.id === id);

    // Load analyzed lessons from localStorage
    const [analyzedLessons, setAnalyzedLessons] = useState<AnalyzedLesson[]>(() => {
        try {
            const saved = localStorage.getItem(`mudhakara_analyzedlessons_${id}`);
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });

    const lesson = analyzedLessons[idx];

    // Quiz interaction state
    const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
    const [quizRevealed, setQuizRevealed] = useState<Record<number, boolean>>({});
    const [showEssayAnswer, setShowEssayAnswer] = useState<Record<number, boolean>>({});
    const [activeQuizTab, setActiveQuizTab] = useState<'mcq' | 'tf' | 'essay'>('mcq');

    if (!subject || !lesson) {
        return (
            <div className="max-w-4xl mx-auto px-4 py-16 text-center font-['Cairo']">
                <div className="w-16 h-16 bg-red-50 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4">
                    <X size={32} />
                </div>
                <h2 className="text-xl font-black text-slate-800 mb-2">الدرس غير موجود</h2>
                <p className="text-slate-500 text-sm mb-6">ربما تم مسح التحليل أو الرابط غير صحيح.</p>
                <Link to={`/subject/${id}`} className="inline-flex items-center gap-2 bg-indigo-600 text-white px-6 py-3 rounded-2xl font-bold text-sm">
                    <ChevronRight size={18} />
                    <span>العودة للمادة</span>
                </Link>
            </div>
        );
    }

    // Separate quizzes by type
    const mcqQuizzes = lesson.quizzes.filter(q => (q.type === 'mcq' || q.type === 'multiple_choice' || !q.type) && q.options?.length > 2);
    const tfQuizzes = lesson.quizzes.filter(q => q.type === 'true_false' || (q.options?.length === 2 && q.options.some(o => o === 'صح' || o === 'صواب' || o === 'خطأ')));
    const essayQuestions = lesson.essayQuestions || [];

    return (
        <div className="max-w-4xl mx-auto px-4 py-8 min-h-screen font-['Cairo'] pb-24">
            {/* Header */}
            <header className="flex items-center gap-4 mb-8">
                <Link to={`/subject/${id}`} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <ChevronRight size={24} />
                </Link>
                <div className="text-right flex-1">
                    <p className="text-[10px] text-slate-400 font-bold tracking-widest uppercase mb-1">{subject.name}</p>
                    <h1 className="text-2xl font-black text-slate-800">{lesson.lessonTitle}</h1>
                </div>
                <div className="bg-indigo-100 text-indigo-700 text-sm font-black px-4 py-2 rounded-2xl">
                    {idx + 1}
                </div>
            </header>

            <div className="space-y-10">
                {/* ─── Summary / Detailed Explanation ──────────────────── */}
                {lesson.detailedExplanation && (
                    <section className="bg-white p-8 md:p-10 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-2 h-full bg-gradient-to-b from-amber-400 to-orange-400"></div>
                        <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center justify-end gap-3">
                            الملخص والشرح التفصيلي
                            <Lightbulb className="text-amber-400" size={24} />
                        </h2>
                        <div className="text-slate-700 leading-relaxed text-base font-medium prose prose-indigo max-w-none">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    h1: ({ node, ...props }) => <h1 className="text-xl font-black text-indigo-700 mb-3 mt-5" {...props} />,
                                    h2: ({ node, ...props }) => <h2 className="text-lg font-black text-indigo-600 mb-2 mt-4" {...props} />,
                                    h3: ({ node, ...props }) => <h3 className="text-base font-bold text-indigo-500 mb-2 mt-3" {...props} />,
                                    p: ({ node, ...props }) => <p className="mb-3 text-justify leading-relaxed" {...props} />,
                                    ul: ({ node, ...props }) => <ul className="list-disc list-inside space-y-1 my-3 mr-4" {...props} />,
                                    ol: ({ node, ...props }) => <ol className="list-decimal list-inside space-y-1 my-3 mr-4" {...props} />,
                                    li: ({ node, ...props }) => <li className="text-slate-700 leading-relaxed" {...props} />,
                                    blockquote: ({ node, ...props }) => <blockquote className="border-r-4 border-indigo-300 bg-indigo-50/50 pr-4 py-2 my-3 rounded-lg" {...props} />,
                                    table: ({ node, ...props }) => <div className="overflow-x-auto my-4"><table className="w-full text-right border-collapse border border-slate-200 rounded-xl overflow-hidden" {...props} /></div>,
                                    th: ({ node, ...props }) => <th className="bg-indigo-50 border border-slate-200 p-3 text-indigo-700 font-black text-xs" {...props} />,
                                    td: ({ node, ...props }) => <td className="border border-slate-100 p-3 text-xs" {...props} />,
                                    strong: ({ node, ...props }) => <strong className="text-indigo-700 font-black" {...props} />,
                                }}
                            >
                                {lesson.detailedExplanation}
                            </ReactMarkdown>
                        </div>
                    </section>
                )}

                {/* ─── Focus Points ──────────────────── */}
                {lesson.focusPoints.length > 0 && (
                    <section className="bg-white p-8 md:p-10 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-2 h-full bg-emerald-500"></div>
                        <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center justify-end gap-3">
                            نقاط التركيز ({lesson.focusPoints.length})
                            <Target className="text-emerald-500" size={24} />
                        </h2>
                        <div className="space-y-4">
                            {lesson.focusPoints.map((fp, i) => (
                                <div key={i} className="p-5 bg-emerald-50/50 rounded-2xl border border-emerald-100">
                                    <h3 className="font-bold text-base text-slate-900 mb-2 flex items-center gap-2 justify-end">
                                        {fp.title}
                                        <span className="w-6 h-6 bg-emerald-500 text-white rounded-full flex items-center justify-center text-[10px] font-black">{i + 1}</span>
                                    </h3>
                                    <p className="text-slate-600 text-sm leading-relaxed">{fp.details}</p>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {/* ─── Quizzes Section ──────────────────── */}
                {(mcqQuizzes.length > 0 || tfQuizzes.length > 0 || essayQuestions.length > 0) && (
                    <section className="bg-white p-8 md:p-10 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-2 h-full bg-gradient-to-b from-purple-500 to-pink-500"></div>
                        <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center justify-end gap-3">
                            الأسئلة والاختبارات
                            <HelpCircle className="text-purple-500" size={24} />
                        </h2>

                        {/* Quiz Type Tabs */}
                        <div className="flex p-1 bg-slate-100 rounded-2xl mb-6">
                            {mcqQuizzes.length > 0 && (
                                <button onClick={() => setActiveQuizTab('mcq')} className={`flex-1 py-2.5 rounded-xl font-bold text-xs transition-all ${activeQuizTab === 'mcq' ? 'bg-white shadow text-indigo-600' : 'text-slate-500'}`}>
                                    اختياري ({mcqQuizzes.length})
                                </button>
                            )}
                            {tfQuizzes.length > 0 && (
                                <button onClick={() => setActiveQuizTab('tf')} className={`flex-1 py-2.5 rounded-xl font-bold text-xs transition-all ${activeQuizTab === 'tf' ? 'bg-white shadow text-indigo-600' : 'text-slate-500'}`}>
                                    صح/خطأ ({tfQuizzes.length})
                                </button>
                            )}
                            {essayQuestions.length > 0 && (
                                <button onClick={() => setActiveQuizTab('essay')} className={`flex-1 py-2.5 rounded-xl font-bold text-xs transition-all ${activeQuizTab === 'essay' ? 'bg-white shadow text-indigo-600' : 'text-slate-500'}`}>
                                    مقالي ({essayQuestions.length})
                                </button>
                            )}
                        </div>

                        {/* MCQ Questions */}
                        {activeQuizTab === 'mcq' && (
                            <div className="space-y-6">
                                {mcqQuizzes.map((q, qi) => (
                                    <div key={qi} className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                                        <p className="font-bold text-slate-800 mb-4 text-sm flex items-start gap-2 justify-end">
                                            {q.question}
                                            <span className="bg-indigo-100 text-indigo-700 text-[10px] font-black px-2 py-1 rounded-full shrink-0">{qi + 1}</span>
                                        </p>
                                        <div className="grid gap-2">
                                            {q.options.map((opt, oi) => {
                                                const isSelected = quizAnswers[qi] === oi;
                                                const isRevealed = quizRevealed[qi];
                                                const isCorrect = oi === q.correctAnswer;
                                                return (
                                                    <button
                                                        key={oi}
                                                        onClick={() => {
                                                            if (isRevealed) return;
                                                            setQuizAnswers(prev => ({ ...prev, [qi]: oi }));
                                                            setQuizRevealed(prev => ({ ...prev, [qi]: true }));
                                                        }}
                                                        className={`p-3 rounded-xl text-right text-xs font-bold transition-all border ${isRevealed && isCorrect ? 'bg-emerald-50 border-emerald-300 text-emerald-700' :
                                                                isRevealed && isSelected && !isCorrect ? 'bg-red-50 border-red-300 text-red-700' :
                                                                    isSelected ? 'bg-indigo-50 border-indigo-300 text-indigo-700' :
                                                                        'bg-white border-slate-100 text-slate-700 hover:bg-slate-50'
                                                            }`}
                                                    >
                                                        {opt}
                                                        {isRevealed && isCorrect && <CheckCircle2 size={14} className="inline ml-2 text-emerald-500" />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        {quizRevealed[qi] && q.explanation && (
                                            <div className="mt-3 p-3 bg-indigo-50 rounded-xl text-xs text-indigo-700 font-bold">
                                                💡 {q.explanation}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* True/False Questions */}
                        {activeQuizTab === 'tf' && (
                            <div className="space-y-4">
                                {tfQuizzes.map((q, qi) => {
                                    const tfIdx = mcqQuizzes.length + qi;
                                    return (
                                        <div key={qi} className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                                            <p className="font-bold text-slate-800 mb-3 text-sm">{q.question}</p>
                                            <div className="flex gap-2">
                                                {q.options.map((opt, oi) => {
                                                    const isSelected = quizAnswers[tfIdx] === oi;
                                                    const isRevealed = quizRevealed[tfIdx];
                                                    const isCorrect = oi === q.correctAnswer;
                                                    return (
                                                        <button key={oi} onClick={() => {
                                                            if (isRevealed) return;
                                                            setQuizAnswers(prev => ({ ...prev, [tfIdx]: oi }));
                                                            setQuizRevealed(prev => ({ ...prev, [tfIdx]: true }));
                                                        }} className={`flex-1 py-3 rounded-xl font-bold text-sm transition-all border ${isRevealed && isCorrect ? 'bg-emerald-50 border-emerald-300 text-emerald-700' :
                                                                isRevealed && isSelected && !isCorrect ? 'bg-red-50 border-red-300 text-red-700' :
                                                                    'bg-white border-slate-100 text-slate-700 hover:bg-slate-50'
                                                            }`}>
                                                            {opt}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            {quizRevealed[tfIdx] && q.explanation && (
                                                <div className="mt-3 p-3 bg-indigo-50 rounded-xl text-xs text-indigo-700 font-bold">💡 {q.explanation}</div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Essay Questions */}
                        {activeQuizTab === 'essay' && (
                            <div className="space-y-4">
                                {essayQuestions.map((eq, ei) => (
                                    <div key={ei} className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                                        <p className="font-bold text-slate-800 mb-3 text-sm flex items-start gap-2 justify-end">
                                            {eq.question}
                                            <span className="bg-purple-100 text-purple-700 text-[10px] font-black px-2 py-1 rounded-full shrink-0">{ei + 1}</span>
                                        </p>
                                        <button
                                            onClick={() => setShowEssayAnswer(prev => ({ ...prev, [ei]: !prev[ei] }))}
                                            className="flex items-center gap-2 text-indigo-600 font-bold text-xs hover:text-indigo-700 transition-colors"
                                        >
                                            {showEssayAnswer[ei] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                            <span>{showEssayAnswer[ei] ? 'إخفاء الإجابة' : 'عرض الإجابة النموذجية'}</span>
                                        </button>
                                        {showEssayAnswer[ei] && (
                                            <div className="mt-3 p-4 bg-indigo-50 rounded-xl text-sm text-slate-700 leading-relaxed border border-indigo-100">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                    {eq.idealAnswer}
                                                </ReactMarkdown>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </div>
    );
};

export default AnalyzedLessonDetail;
