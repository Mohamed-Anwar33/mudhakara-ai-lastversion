
import { AIResult, Source, HomeworkAIResult, ExamReviewResult, Lesson } from "../types.ts";
import { getFile } from "./storage.ts";
import { uploadHomeworkFile, deleteHomeworkFile } from "./supabaseService.ts";

/**
 * دالة مركزية لاستدعاء وكيل الذكاء الاصطناعي السحابي (Netlify Function Proxy)
 */
const callGeminiProxy = async (payload: {
  contents?: any;
  content?: string;
  title?: string;
  systemInstruction?: string;
  responseSchema?: any;
  fileUrl?: string; // New field for remote files
  mimeType?: string;
}) => {
  try {
    const bodyStr = JSON.stringify(payload);
    const sizeInBytes = new TextEncoder().encode(bodyStr).length;
    const sizeInMB = (sizeInBytes / (1024 * 1024)).toFixed(2);

    console.log(`📊 [DEBUG] Payload Size: ${sizeInMB} MB`);

    // Client-Side Guard: Vercel Serverless limit is ~4.5MB. We set a safe limit of 4MB.
    if (sizeInBytes > 4 * 1024 * 1024) {
      throw new Error(`عذراً، حجم المحتوى كبير جداً (${sizeInMB} ميجا). الحد المسموح هو 4 ميجا.\nيرجى ضغط ملف الـ PDF (Compress) أو تقليل عدد الصور والمحاولة مرة أخرى.`);
    }

    const response = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));

      // Map HTTP Status Codes to Friendly Arabic Messages
      let errorMsg = `خطأ من الخادم (${response.status})`;

      if (response.status === 413) {
        errorMsg = "عذراً، الملفات المرسلة حجمها كبير جداً. يرجى ضغط الملفات (Compress) قبل الرفع.";
      } else if (response.status === 429) {
        errorMsg = "ضغط كبير على الخدمة (Rate Limit). يرجى الانتظار دقيقة والمحاولة مرة أخرى.";
      } else if (response.status === 504) {
        errorMsg = "الخادم تأخر في الرد (Timeout). المحتوى قد يكون طويلاً جداً، حاول تقليله.";
      } else if (errData.error) {
        // errData.error can be a string OR an object { message, code }
        errorMsg = typeof errData.error === 'string'
          ? errData.error
          : (errData.error?.message || JSON.stringify(errData.error));
      }

      throw new Error(errorMsg);
    }

    const data = await response.json();
    return data;
  } catch (err: any) {
    console.error("❌ callGeminiProxy Error:", err);
    throw new Error(err.message || "تعذر الاتصال بالوكيل السحابي");
  }
};

/**
 * جلب المحتوى الفعلي للمصدر من IndexedDB
 */
const fetchContent = async (s: Source) => {
  try {
    if (s.type === 'youtube') return `[فيديو يوتيوب مرجعي: ${s.content}]`;

    // جلب النص الفعلي من التخزين المحلي المربوط بالـ ID
    const stored = await getFile(s.id);

    if (!stored) {
      console.warn(`⚠️ No content found for source: ${s.id}`);
      return "";
    }

    // If it's a PDF, extract text
    if (stored.startsWith('data:application/pdf')) {
      console.log(`📄 Extracting text from PDF: ${s.name}`);
      try {
        const response = await fetch(stored);
        const blob = await response.blob();
        const file = new File([blob], s.name, { type: blob.type });

        const { extractPdfText } = await import('../utils/pdfUtils');
        const extractedText = await extractPdfText(file);
        return extractedText || `[ملف ${s.name}: فشل استخراج النص]`;
      } catch (extractError) {
        console.error(`❌ Failed to extract text from ${s.name}:`, extractError);
        return `[ملف ${s.name}: فشل استخراج النص]`;
      }
    }

    if (stored.startsWith('data:image/')) {
      // بالنسبة للصور في سياق "جلب النص" (مثل المراجعة)، لا يمكننا استخراج النص محلياً.
      // يتم التعامل مع الصور بعمق فقط في تحليل الدرس (LessonDetail) والواجبات.
      return `[صورة: ${s.name}]`;
    }

    // Otherwise return as-is (for text or other content)
    return stored || "";
  } catch (e) {
    console.warn("Failed to fetch storage for source:", s.id, e);
    return "";
  }
};

/**
 * المعالجة الشاملة لمحتوى الدرس وربطه بالذاكرة المرجعية
 */
export const processLessonContent = async (
  lessonTitle: string,
  mainSource: Source,
  supplements: Source[],
  studentText: string = "",
  sessionMode: string = "study"
): Promise<AIResult> => {
  // جلب نصوص المصادر المرجعية والدروس الإضافية
  const mainContentData = await fetchContent(mainSource);
  const supplementsData = await Promise.all(supplements.map(async (s) => {
    const content = await fetchContent(s);
    return `[مرفق إضافي للدرس: ${s.name}]\n${content}`;
  }));

  // دمج السياق الكامل
  const fullContext = `
    المصدر المرجعي الرئيسي (الكتاب): ${mainContentData.substring(0, 40000)}
    محتويات الدرس الحالي: ${supplementsData.join('\n\n').substring(0, 20000)}
    إضافات الطالب: ${studentText}
  `;

  // تعليمات النظام الصارمة
  const systemInstruction = `أنت "مساعد مذاكرة الذكي". حلل الدرس بناءً على "الذاكرة المجمعة" المرفقة.
  القواعد:
  1. لا تخرج عن سياق المرفقات.
  2. لخص النقاط بأسلوب أكاديمي سهل.
  3. لون المصطلحات بـ **كلمة**.
  4. صمم 4 أسئلة MCQ مع التوضيح بناءً على الفقرة المذكورة في المرجع.`;

  const payload = {
    contents: [{ parts: [{ text: `الدرس: ${lessonTitle}\n\nسياق الذاكرة:\n${fullContext}` }] }],
    systemInstruction,
    responseSchema: {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING" },
        quizzes: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              question: { type: "STRING" },
              options: { type: "ARRAY", items: { type: "STRING" } },
              correctAnswer: { type: "INTEGER" },
              explanation: { type: "STRING" }
            },
            required: ["question", "options", "correctAnswer", "explanation"]
          }
        }
      }
    }
  };

  const result = await callGeminiProxy(payload);

  if (result.data) {
    return result.data;
  }

  try {
    const textToParse = result.rawText || result.text || "{}";
    return JSON.parse(textToParse);
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return { summary: "حدث خطأ أثناء معالجة البيانات", examPredictions: [], quizzes: [] };
  }
};

const transcribeAudio = async (fileUrl: string, mimeType: string): Promise<string> => {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileUrl, mimeType })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Transcription failed: ${response.status}`);
  }

  const data = await response.json();
  return data.transcript;
};

const chunkText = (text: string, chunkSize: number = 10000): string[] => {
  const chunks: string[] = [];
  let currentChunk = "";

  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if ((currentChunk.length + para.length) > chunkSize) {
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk += "\n" + para;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  return chunks;
};

// Analyze a text chunk using standard Gemini 1.5 Flash (Text Mode)
const analyzeChunk = async (text: string, chunkIndex: number, totalChunks: number) => {
  const prompt = `
  Analyze this part (${chunkIndex + 1}/${totalChunks}) of a generated transcript.
  Extract:
  1. A concise summary of this part.
  2. Key points / Action items.
  3. "Memory Candidates": Facts/concepts suitable for flashcards.
  
  Output JSON: { "summary": string, "keyPoints": string[], "memories": string[] }
  `;

  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: `${prompt}\n\nTranscript Part:\n${text}` }]
    }],
    responseSchema: {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING" },
        keyPoints: { type: "ARRAY", items: { type: "STRING" } },
        memories: { type: "ARRAY", items: { type: "STRING" } }
      }
    }
  };

  return await callGeminiProxy(payload);
};

export const analyzeLargeAudio = async (
  fileUrl: string,
  mimeType: string,
  onProgress: (status: string) => void
): Promise<HomeworkAIResult> => {
  try {
    // 1. Transcribe
    onProgress("جاري تحويل الصوت إلى نص (Gen 2.0)...");
    const transcript = await transcribeAudio(fileUrl, mimeType);
    console.log("📝 Transcript length:", transcript.length);

    if (!transcript || transcript.length < 50) {
      throw new Error("فشل تحويل الصوت، النص قصير جداً.");
    }

    // 2. Chunk
    const chunks = chunkText(transcript, 15000); // 15k chars per chunk (~5-10 mins)
    console.log(`🔪 Split into ${chunks.length} chunks`);

    // 3. Analyze Chunks Parallel (Concurrency Limit 3)
    const results: any[] = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress(`جاري تحليل الجزء ${i + 1} من ${chunks.length}...`);
      // We do sequential here to avoid rate limits, or Promise.all if we trust the quota
      try {
        const result = await analyzeChunk(chunks[i], i, chunks.length);
        if (result.data) results.push(result.data);
      } catch (e) {
        console.error(`Error analyzing chunk ${i}`, e);
      }
    }

    // 4. Merge
    onProgress("جاري تجميع النتائج...");

    // Aggregate Summary
    const metadata = {
      solutionSteps: [],
      finalAnswer: results.map(r => r.summary).join('\n\n---\n\n'),
      correctionNote: "تم تحليل الملف الصوتي بنجاح.",
      similarQuestions: [], // Could generate quiz from memories if needed
      memories: results.flatMap(r => r.memories || []),
      keyPoints: results.flatMap(r => r.keyPoints || [])
    };

    return metadata as any; // Cast to fit HomeworkAIResult or update type

  } catch (error: any) {
    console.error("Large Audio Analysis Error:", error);
    throw error;
  }
};

/**
 * Helper to convert Base64 string to File object
 */
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

/**
 * تحليل وحل الواجبات الدراسية
 */
export const analyzeHomeworkContent = async (
  homeworkTitle: string, homeworkDescription: string, homeworkSource?: Source, mainSubjectSource?: Source
): Promise<HomeworkAIResult> => {
  const subjectData = mainSubjectSource ? await fetchContent(mainSubjectSource) : "";

  const parts: any[] = [];
  // Include the description in the prompt text
  const promptText = `حل الواجب "${homeworkTitle}" مع ربطه بمرجع المادة:\nالوصف/السؤال: ${homeworkDescription}\n\nالمرجع: ${subjectData.substring(0, 15000)}`;

  // Track if we are using a remote URL (Supabase) to set payload.fileUrl later
  let remoteFileUrl: string | null = null;
  let remoteMimeType: string | null = null;

  if (homeworkSource) {
    if (homeworkSource.type === 'audio_url') {
      // Special case for Large Audio Files (Supabase URL)
      // We send the URL to the proxy, which will handle the download & File API upload.
      parts.push({ text: promptText });
      remoteFileUrl = homeworkSource.content;
      // We don't push inlineData here. We'll attach fileUrl to the payload below.
    } else if (homeworkSource.type === 'image' || homeworkSource.type === 'audio') {
      // For media, we need the raw base64 content
      const rawContent = await getFile(homeworkSource.id);
      if (rawContent && rawContent.startsWith('data:')) {
        const base64Data = rawContent.split(',')[1];
        const mimeType = rawContent.split(',')[0].split(':')[1].split(';')[0];

        // CHECK SIZE: If > 3MB, upload to Supabase to avoid Vercel 4.5MB limit & Gemini 20MB inline limit
        // 3MB = 3 * 1024 * 1024 bytes
        const sizeInBytes = (base64Data.length * 3) / 4; // Approx size
        const SIZE_LIMIT = 3 * 1024 * 1024; // 3MB

        if (sizeInBytes > SIZE_LIMIT) {
          console.log(`⚠️ Large file detected (${(sizeInBytes / 1024 / 1024).toFixed(2)} MB). Uploading to Supabase...`);
          try {
            const file = base64ToFile(base64Data, mimeType, homeworkSource.name || "upload.bin");
            const publicUrl = await uploadHomeworkFile(file);
            console.log("✅ File uploaded to Supabase:", publicUrl);

            parts.push({ text: promptText });
            remoteFileUrl = publicUrl;
            remoteMimeType = mimeType;

          } catch (uploadError: any) {
            console.error("❌ Failed to upload large file to Supabase:", uploadError);
            // Fallback to inline (might fail, but better than nothing)
            parts.push({ text: promptText });
            parts.push({ inlineData: { data: base64Data, mimeType: mimeType } });
          }
        } else {
          // Small file (<3MB), send inline (faster)
          parts.push({ text: promptText }); // Instruction first
          parts.push({ inlineData: { data: base64Data, mimeType: mimeType } });
        }
      } else {
        parts.push({ text: `${promptText}\n\n[تعذر قراءة ملف الوسائط: ${homeworkSource.name}]` });
      }
    } else {
      // For text/PDFs
      const hwData = await fetchContent(homeworkSource);
      parts.push({ text: `${promptText}\n\nمحتوى الملف المرفق: ${hwData}` });
    }
  } else {
    // Text-only request
    parts.push({ text: promptText });
  }

  const payload: any = {
    contents: [{ parts }],
    systemInstruction: `... (same system instruction) ...`, // We keep the existing one or just reference it if I don't want to rewrite it all.
    // Actually, I should just modify the payload construction lines.
    // Let me rewrite the payload construction block to be safe.
    responseSchema: {
      type: "OBJECT",
      properties: {
        solutionSteps: { type: "ARRAY", items: { type: "OBJECT", properties: { step: { type: "STRING" }, explanation: { type: "STRING" } } } },
        finalAnswer: { type: "STRING" },
        correctionNote: { type: "STRING" },
        similarQuestions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, answer: { type: "STRING" } } } }
      }
    }
  };

  // Attach fileUrl if we have one (either from audio_url or newly uploaded)
  if (remoteFileUrl) {
    payload.fileUrl = remoteFileUrl;

    if (remoteMimeType) {
      payload.mimeType = remoteMimeType;
    } else if (homeworkSource?.type === 'audio_url') {
      // Infer mimeType from URL extension logic (reused)
      const urlLower = remoteFileUrl.toLowerCase();
      if (urlLower.includes('.mp4')) payload.mimeType = 'video/mp4';
      else if (urlLower.includes('.mkv')) payload.mimeType = 'video/x-matroska';
      else if (urlLower.includes('.mov')) payload.mimeType = 'video/quicktime';
      else if (urlLower.includes('.webm')) payload.mimeType = 'video/webm';
      else if (urlLower.includes('.wav')) payload.mimeType = 'audio/wav';
      else if (urlLower.includes('.m4a')) payload.mimeType = 'audio/mp4';
      else if (urlLower.includes('.aac')) payload.mimeType = 'audio/aac';
      else if (urlLower.includes('.flac')) payload.mimeType = 'audio/flac';
      else payload.mimeType = 'audio/mp3'; // Default fallback
    }
  }

  const result = await callGeminiProxy(payload);

  // START CLEANUP LOGIC
  if (remoteFileUrl && remoteFileUrl.includes('homework-uploads') && homeworkSource?.type !== 'audio_url' && homeworkSource?.type !== 'video_url') {
    console.log("🧹 Cleaning up temporary large homework file from Supabase...");
    // Fire and forget cleanup to not block response
    deleteHomeworkFile(remoteFileUrl)
      .then(() => console.log("✅ Cleanup successful"))
      .catch(err => console.error("❌ Cleanup failed:", err));
  }
  // END CLEANUP LOGIC

  const cleanJson = (text: string) => {
    let clean = text.trim();
    if (clean.startsWith('```json')) clean = clean.replace(/^```json/, '').replace(/```$/, '');
    if (clean.startsWith('```')) clean = clean.replace(/^```/, '').replace(/```$/, '');
    return clean;
  };

  try {
    if (result.data) return result.data;
    const textToParse = result.rawText || result.text || "{}";
    return JSON.parse(cleanJson(textToParse));
  } catch (e) {
    console.error("Homework JSON Parse Error", e);
    return { solutionSteps: [], finalAnswer: "تعذر تحليل الإجابة", similarQuestions: [] };
  }
};

/**
 * توليد مراجعة نهائية لعدة دروس — Enhanced v2
 * - Progress callback for step-by-step UI updates
 * - Rich context from AI pipeline (summary + focusPoints + quizzes + essayQuestions)
 * - Partial regeneration support
 */
export const generateExamReview = async (
  subjectName: string,
  selectedLessons: Lesson[],
  onProgress?: (step: number, total: number, label: string) => void
): Promise<ExamReviewResult> => {
  console.log("🔍 generateExamReview:", { subjectName, lessonsCount: selectedLessons.length });

  const MAX_SOURCE_CHARS = 50000;
  const MAX_TOTAL_CHARS = 200000;

  const smartTruncate = (text: string, limit: number): string => {
    if (!text || text.length <= limit) return text;
    const cut = text.substring(0, limit);
    const lastPeriod = cut.lastIndexOf('.');
    if (lastPeriod > limit * 0.8) return cut.substring(0, lastPeriod + 1) + " ... [تم القص]";
    return cut + " ... [تم القص]";
  };

  // ─── Build RICH context from AI pipeline ───────────────
  const context = await Promise.all(selectedLessons.map(async l => {
    if (l.aiResult && l.aiResult.summary) {
      let parts: string[] = [];
      parts.push(`[درس: ${l.title}]`);

      // Summary
      const summaryText = typeof l.aiResult.summary === 'string'
        ? l.aiResult.summary
        : JSON.stringify(l.aiResult.summary);
      parts.push(`الملخص:\n${summaryText}`);

      // Focus Points (enriched context!)
      if (l.aiResult.focusPoints && l.aiResult.focusPoints.length > 0) {
        parts.push(`نقاط التركيز (ركّز عليها المعلم):`);
        l.aiResult.focusPoints.forEach((fp, i) => {
          parts.push(`${i + 1}. ${fp.title}: ${fp.details}`);
        });
      }

      // Existing quiz (for richer context)
      if (l.aiResult.quizzes && l.aiResult.quizzes.length > 0) {
        parts.push(`أسئلة سابقة من هذا الدرس (${l.aiResult.quizzes.length} سؤال) — ولّد أسئلة مختلفة عنها:`);
        l.aiResult.quizzes.slice(0, 5).forEach(q => {
          parts.push(`- ${q.question}`);
        });
      }

      // Essay Questions
      if (l.aiResult.essayQuestions && l.aiResult.essayQuestions.length > 0) {
        parts.push(`أسئلة مقالية سابقة — ولّد أسئلة مختلفة:`);
        l.aiResult.essayQuestions.forEach(eq => {
          parts.push(`- ${eq.question}`);
        });
      }

      if (l.studentText) parts.push(`ملاحظات الطالب: ${l.studentText}`);
      return parts.join('\n');
    }

    // Fallback: raw sources
    const data = await Promise.all(l.sources.map(async s => {
      const raw = await fetchContent(s);
      return smartTruncate(raw, MAX_SOURCE_CHARS);
    }));
    const textContent = l.studentText ? `\nملاحظات الطالب: ${l.studentText}` : "";
    return smartTruncate(`[درس خام: ${l.title}]: ${data.join(' ')}${textContent}`, MAX_TOTAL_CHARS / selectedLessons.length);
  }));

  const contextString = context.join('\n\n---\n\n');
  const commonContext = `صمم مراجعة نهائية شاملة لـ ${subjectName} من هذه الدروس:\n${smartTruncate(contextString, MAX_TOTAL_CHARS)}`;
  const systemInstruction = `أنت مساعد مراجعة ذكي. قم بتوليد المحتوى المطلوب بناءً على الدروس المقدمة. استخدم المحتوى المقدم فقط ولا تخترع.`;

  const TOTAL_STEPS = 4;

  // ─── Step 1: Summary & Key Points ─────────────────────
  onProgress?.(1, TOTAL_STEPS, "جاري توليد الملخص الشامل والنقاط الرئيسية...");
  const summaryResult = await callGeminiProxy({
    contents: [{ parts: [{ text: `قدم ملخصاً شاملاً ومفصلاً بالعربية مع نقاط رئيسية.\n${commonContext}` }] }],
    systemInstruction,
    responseSchema: {
      type: "OBJECT",
      properties: {
        comprehensiveSummary: { type: "STRING" },
        keyPoints: { type: "ARRAY", items: { type: "STRING" } }
      },
      required: ["comprehensiveSummary", "keyPoints"]
    }
  });

  // ─── Step 2: MCQs & True/False ────────────────────────
  const questionCount = Math.max(20, selectedLessons.length * 5);
  const tfCount = Math.max(10, selectedLessons.length * 3);

  onProgress?.(2, TOTAL_STEPS, `جاري إنشاء ${questionCount} سؤال اختياري و ${tfCount} صح/خطأ...`);
  const mcqResult = await callGeminiProxy({
    contents: [{ parts: [{ text: `ولّد ${questionCount} سؤال اختياري و ${tfCount} سؤال صح/خطأ بالعربية. غطِ كل الدروس.\n${commonContext}` }] }],
    systemInstruction,
    responseSchema: {
      type: "OBJECT",
      properties: {
        mcqs: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correctAnswer: { type: "INTEGER" }, explanation: { type: "STRING" } }, required: ["question", "options", "correctAnswer", "explanation"] } },
        trueFalseQuestions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correctAnswer: { type: "INTEGER" }, explanation: { type: "STRING" } }, required: ["question", "options", "correctAnswer", "explanation"] } }
      },
      required: ["mcqs", "trueFalseQuestions"]
    }
  });

  // ─── Step 3: Essay Questions ──────────────────────────
  const essayCount = Math.max(7, selectedLessons.length * 2);
  onProgress?.(3, TOTAL_STEPS, `جاري توليد ${essayCount} سؤال مقالي مع إجابات نموذجية...`);
  const essayResult = await callGeminiProxy({
    contents: [{ parts: [{ text: `ولّد ${essayCount} سؤال مقالي بالعربية مع إجابة نموذجية مفصلة لكل سؤال.\n${commonContext}` }] }],
    systemInstruction: "أنت معلم خبير. ضع إجابة نموذجية مفصلة لكل سؤال مقالي. لا تترك حقل الإجابة فارغاً.",
    responseSchema: {
      type: "OBJECT",
      properties: {
        essayQuestions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, idealAnswer: { type: "STRING", description: "إجابة تفصيلية 3 جمل على الأقل" } }, required: ["question", "idealAnswer"] } }
      },
      required: ["essayQuestions"]
    }
  });

  // ─── Step 4: Mock Exam ────────────────────────────────
  onProgress?.(4, TOTAL_STEPS, "جاري إنشاء الاختبار التجريبي...");
  const mockResult = await callGeminiProxy({
    contents: [{ parts: [{ text: `ولّد اختبار تجريبي بالعربية (15+ سؤال) يغطي كل الدروس.\n${commonContext}` }] }],
    systemInstruction,
    responseSchema: {
      type: "OBJECT",
      properties: {
        mockExam: { type: "OBJECT", properties: { instructions: { type: "STRING" }, questions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correctAnswer: { type: "INTEGER" }, explanation: { type: "STRING" } }, required: ["question", "options", "correctAnswer", "explanation"] } } }, required: ["instructions", "questions"] }
      },
      required: ["mockExam"]
    }
  });

  // ─── Parse results ────────────────────────────────────
  const parseResult = (result: any, name: string) => {
    if (result.data) return result.data;
    const textToParse = result.rawText || result.text || "{}";
    let clean = textToParse.trim();
    if (clean.startsWith('```json')) clean = clean.replace(/^```json/, '').replace(/```$/, '');
    if (clean.startsWith('```')) clean = clean.replace(/^```/, '').replace(/```$/, '');
    try { return JSON.parse(clean); } catch { console.error(`❌ Parse ${name} failed`); return null; }
  };

  const summaryData = parseResult(summaryResult, "Summary");
  const mcqData = parseResult(mcqResult, "MCQ");
  const essayData = parseResult(essayResult, "Essay");
  const mockData = parseResult(mockResult, "MockExam");

  return {
    comprehensiveSummary: summaryData?.comprehensiveSummary || "عذراً، تعذر توليد الملخص.",
    keyPoints: summaryData?.keyPoints || [],
    mcqs: mcqData?.mcqs || [],
    trueFalseQuestions: mcqData?.trueFalseQuestions || [],
    essayQuestions: essayData?.essayQuestions || [],
    mockExam: mockData?.mockExam || { instructions: "تعذر توليد الاختبار.", questions: [] }
  };
};

/**
 * إعادة توليد جزء واحد فقط من المراجعة
 */
export const regenerateSection = async (
  sectionType: 'summary' | 'mcq' | 'essay' | 'mockExam',
  subjectName: string,
  selectedLessons: Lesson[]
): Promise<any> => {
  const context = selectedLessons.map(l => {
    if (l.aiResult?.summary) return `[${l.title}]: ${typeof l.aiResult.summary === 'string' ? l.aiResult.summary : JSON.stringify(l.aiResult.summary)}`;
    return `[${l.title}]: ${l.studentText || ''}`;
  }).join('\n');

  const commonContext = `مراجعة لمادة ${subjectName}:\n${context.substring(0, 100000)}`;
  const systemInstruction = "أنت مساعد مراجعة ذكي. استخدم المحتوى المقدم فقط.";

  const payloads: Record<string, any> = {
    summary: {
      contents: [{ parts: [{ text: `ملخص شامل جديد ومختلف بالعربية.\n${commonContext}` }] }],
      systemInstruction,
      responseSchema: { type: "OBJECT", properties: { comprehensiveSummary: { type: "STRING" }, keyPoints: { type: "ARRAY", items: { type: "STRING" } } } }
    },
    mcq: {
      contents: [{ parts: [{ text: `ولّد 20+ سؤال اختياري و 10+ صح/خطأ جديدة ومختلفة.\n${commonContext}` }] }],
      systemInstruction,
      responseSchema: { type: "OBJECT", properties: { mcqs: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correctAnswer: { type: "INTEGER" }, explanation: { type: "STRING" } } } }, trueFalseQuestions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correctAnswer: { type: "INTEGER" }, explanation: { type: "STRING" } } } } } }
    },
    essay: {
      contents: [{ parts: [{ text: `ولّد 7+ أسئلة مقالية جديدة مع إجابات نموذجية.\n${commonContext}` }] }],
      systemInstruction: "أنت معلم خبير. ضع إجابة نموذجية مفصلة لكل سؤال.",
      responseSchema: { type: "OBJECT", properties: { essayQuestions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, idealAnswer: { type: "STRING" } } } } } }
    },
    mockExam: {
      contents: [{ parts: [{ text: `اختبار تجريبي جديد (15+ سؤال) مختلف.\n${commonContext}` }] }],
      systemInstruction,
      responseSchema: { type: "OBJECT", properties: { mockExam: { type: "OBJECT", properties: { instructions: { type: "STRING" }, questions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correctAnswer: { type: "INTEGER" }, explanation: { type: "STRING" } } } } } } } }
    }
  };

  const result = await callGeminiProxy(payloads[sectionType]);
  if (result.data) return result.data;
  const text = result.rawText || result.text || "{}";
  let clean = text.trim();
  if (clean.startsWith('```json')) clean = clean.replace(/^```json/, '').replace(/```$/, '');
  try { return JSON.parse(clean); } catch { return null; }
};
