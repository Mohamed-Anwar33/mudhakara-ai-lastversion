
export interface User {
  id?: string;
  name: string;
  email: string;
  picture: string;
}

export interface Subject {
  id: string;
  user_id?: string; // Links to Supabase Auth User ID
  name: string;
  code: string;
  university: string;
  description?: string;
  mainSourceId?: string;
  subjectSources?: Source[];            // الملفات المرفوعة على مستوى المادة
  analyzedLessons?: AnalyzedLesson[];   // الدروس المحللة تلقائياً
  analysisStatus?: 'idle' | 'processing' | 'completed' | 'error';
}

export interface Lesson {
  id: string;
  user_id?: string; // Links to Supabase Auth User ID
  subjectId: string;
  title: string;
  createdAt: number;
  sources: Source[];
  studentText?: string;
  requestType: 'study' | 'homework';
  aiResult?: AIResult;
}

export interface Homework {
  id: string;
  subjectId: string;
  title: string;
  description?: string;
  createdAt: number;
  source?: Source;
  aiResult?: HomeworkAIResult;
}

export interface HomeworkAIResult {
  solutionSteps: { step: string; explanation: string }[];
  finalAnswer: string;
  correctionNote?: string;
  similarQuestions: { question: string; answer: string }[];
}

export interface ExamReviewResult {
  comprehensiveSummary: string;
  keyPoints: string[];
  mcqs: Quiz[];
  trueFalseQuestions: Quiz[];
  essayQuestions: { question: string; idealAnswer: string }[];
  mockExam: {
    instructions: string;
    questions: Quiz[];
  };
}

export type SourceType = 'audio' | 'youtube' | 'pdf' | 'text' | 'image' | 'audio_url' | 'document' | 'video_url';

export interface Source {
  id: string;
  type: 'pdf' | 'text' | 'image' | 'audio' | 'youtube' | 'document' | 'audio_url' | 'video_url';
  name: string;
  content: string; // Base64 or Text or URL
  uploadedUrl?: string; // New: Cached URL for large files
  contentHash?: string;
}

export interface FocusPoint {
  title: string;
  details: string;
  evidence?: { pdf_section_ids: string[]; audio_section_ids: string[] };
}

export interface LessonData {
  lesson_title: string;
  detailed_explanation: string;
  rules: string[];
  examples: { word: string; reason: string }[];
}

export interface EssayQuestion {
  question: string;
  idealAnswer: string;
}

export interface AIResult {
  summary: string;
  lessons?: LessonData[];
  focusPoints?: FocusPoint[];
  examPredictions: string[];
  quizzes: Quiz[];
  essayQuestions?: EssayQuestion[];
  homeworkResult?: {
    originalQuestion: string;
    solutionSteps: { step: string; explanation: string }[];
    finalAnswer: string;
    contentLink?: string;
  };
}

export interface Quiz {
  id: string;
  type?: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  evidence?: string;
}

export interface AnalyzedLesson {
  id: string;
  lessonTitle: string;           // عنوان الدرس (يحدده الـ AI)
  summary: string;               // الملخص الذكي
  focusPoints: FocusPoint[];     // نقاط التركيز
  quizzes: Quiz[];               // أسئلة (صح/خطأ + اختياري)
  essayQuestions: EssayQuestion[];// أسئلة مقالية
  detailedExplanation?: string;  // الشرح التفصيلي بالـ Markdown
}

export interface UserPreferences {
  university: string;
  onboarded: boolean;
  user?: User;
}
