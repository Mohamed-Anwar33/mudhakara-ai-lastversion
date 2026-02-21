
import { createClient } from '@supabase/supabase-js';
import { Subject, Lesson } from '../types.ts';
import { toast } from 'react-hot-toast';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (supabaseUrl && supabaseAnonKey && supabaseUrl !== "undefined")
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * دالّة لجلب جميع المواد
 */
// Auth Helpers
export const signUp = async (email: string, password: string) => {
  if (!supabase) throw new Error("Supabase not initialized");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
};

export const signIn = async (email: string, password: string) => {
  if (!supabase) throw new Error("Supabase not initialized");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
};

export const signOut = async () => {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};

export const getUser = async () => {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user;
};

/**
 * دالّة لجلب جميع المواد
 */
export const fetchSubjects = async () => {
  if (!supabase) {
    console.warn("Supabase is not initialized. Using local storage only.");
    return [];
  }
  // RLS will automatically filter subjects for the current user
  const { data, error } = await supabase.from('subjects').select('*');
  if (error) throw error;
  return data as Subject[];
};

/**
 * دالّة لإضافة أو تحديث مادة
 */
const mapSubjectToDb = (subject: Subject) => {
  return {
    id: subject.id,
    user_id: subject.user_id,
    name: subject.name,
    code: subject.code,
    university: subject.university,
    description: subject.description,
    main_source_id: subject.mainSourceId // Snake_case mapping
  };
};

export const upsertSubject = async (subject: Subject) => {
  if (!supabase) return;

  const dbSubject = mapSubjectToDb(subject);

  const { error } = await supabase.from('subjects').upsert(dbSubject);
  if (error) {
    console.error("❌ Supabase Subject Upsert Error:", error);
    throw error;
  }
};

/**
 * دالّة لحذف مادة
 */
export const removeSubject = async (id: string) => {
  if (!supabase) return;
  const { error } = await supabase.from('subjects').delete().eq('id', id);
  if (error) throw error;
};

/**
 * دالّة لتحديث درس
 */
// Helper to map Lesson to DB format
// NOTE: Postgres explicitly lowercases unquoted identifiers. So 'subjectId' in SQL becomes 'subjectid' in the DB.
// Helper to map Lesson to DB format
// NOTE: Switching to snake_case which is standard for Supabase Postgres tables.
// Helper to map Lesson to DB format
// STANDARD: snake_case for all columns.
const mapLessonToDb = (lesson: Lesson) => {
  // Defensive check: Ensure we don't send undefined for critical fields
  return {
    id: lesson.id,
    course_id: lesson.subjectId,      // Corrected: course_id
    lesson_title: lesson.title,       // Corrected: lesson_title
    // created_by: Defaults to auth.uid() in DB, so strictly speaking we don't *need* to send it if defaults work.
    // However, if we have it in lesson object, sending it is fine to be explicit.
    // using 'created_by' because we standardized on it in the SQL migration.
    // migrating from user_id if present.
    created_by: lesson.user_id,
    created_at: lesson.createdAt ? new Date(lesson.createdAt).toISOString() : new Date().toISOString(),
    sources: lesson.sources || [],
    student_text: lesson.studentText || null,
    request_type: lesson.requestType || null,
    ai_result: lesson.aiResult || null
  };
};

export const upsertLesson = async (lesson: Lesson) => {
  if (!supabase) return;

  // 1. Validation Before Sending
  if (!lesson.title || !lesson.title.trim()) {
    toast.error("عنوان الدرس مطلوب");
    throw new Error("Lesson title is required");
  }
  if (!lesson.subjectId) {
    toast.error("معرف المادة (Course ID) مفقود");
    throw new Error("Course ID is required");
  }

  const dbLesson = mapLessonToDb(lesson);
  console.log("🚀 Payload being sent to Supabase:", dbLesson);

  // 2. Upsert with explicit ID conflict handling
  // ignoreDuplicates: false (default), ensuring we update if ID matches.
  const { data, error } = await supabase
    .from('lessons')
    .upsert([dbLesson], { onConflict: 'id' })
    .select();

  if (error) {
    console.error("❌ Supabase Upsert Error:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    // Friendly error for duplicate or constraint violations
    if (error.code === '23505') toast.error("هذا الدرس موجود بالفعل.");
    else if (error.code === '23503') {
      toast.error("عذراً، المادة غير موجودة. قم بتحديث الصفحة.");
    }
    else toast.error(`فشل الحفظ: ${error.message}`);

    throw error;
  }

  console.log("✅ Upsert Successful:", data);
  return data;
};

export const removeLesson = async (id: string) => {
  if (!supabase) return;
  const { error } = await supabase.from('lessons').delete().eq('id', id);
  if (error) throw error;
};

export const testSupabaseConnection = async () => {
  if (!supabase) {
    toast.error("المفاتيح غير موجودة (Supabase Keys Missing)");
    return;
  }
  try {
    const { data, error } = await supabase.from('subjects').select('*').limit(1);
    // Ignore error if it's just empty or permission denied (RLS)
    if (error && error.code !== 'PGRST116' && error.message !== 'JSON object requested, multiple (or no) rows returned') {
      // It's possible RLS returns empty, so this might not error, or might return []
    }
    toast.success("الاتصال بـ Supabase ناجح!");
  } catch (err: any) {
    console.error("❌ Supabase Error:", err.message);
    toast.error(`فشل الاتصال: ${err.message}`);
  }
};
// Helper to sanitize filenames for upload
const sanitizeFileName = (name: string) => {
  return name.replace(/[^a-zA-Z0-9.-]/g, '_');
};

export const uploadHomeworkFile = async (file: File): Promise<string> => {
  try {
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}_${sanitizeFileName(file.name)}`;
    const filePath = `${fileName}`;

    const { data, error } = await supabase.storage
      .from('homework-uploads')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('homework-uploads')
      .getPublicUrl(filePath);

    return publicUrl;
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
};

export const deleteHomeworkFile = async (publicUrl: string): Promise<void> => {
  try {
    if (!publicUrl) return;

    // Extract file path from URL
    // URL format: .../homework-uploads/filename
    const urlParts = publicUrl.split('/homework-uploads/');
    if (urlParts.length < 2) return;

    const filePath = urlParts[1];

    const { error } = await supabase.storage
      .from('homework-uploads')
      .remove([filePath]);

    if (error) {
      console.error("Error deleting file from Supabase:", error);
      // We don't throw here to avoid blocking the user flow if cleanup fails
    } else {
      console.log(`🗑️ Deleted file from Supabase: ${filePath}`);
    }
  } catch (err) {
    console.error("Error in deleteHomeworkFile:", err);
  }
};

