
import { GoogleGenAI, Type } from "@google/genai";

export const handler = async (event: any) => {
  // السماح فقط بطلبات POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body);
    
    // Fix: The API key must be obtained exclusively from the environment variable process.env.API_KEY.
    if (!process.env.API_KEY) {
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: "مفتاح API غير متوفر في إعدادات Netlify. يرجى التأكد من إضافة API_KEY." }) 
      };
    }

    // Fix: Always use new GoogleGenAI({apiKey: process.env.API_KEY}) for initialization.
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    // تحديد المحتوى: إما مرسل جاهز أو من خلال نص الدرس
    let contents = body.contents;
    
    // إذا أرسل المستخدم نصاً مباشراً، نحوله لتنسيق Gemini
    if (!contents && body.lessonText) {
      contents = [{ 
        parts: [{ text: `قم بتحليل المحتوى التالي واستخراج ملخص واختبار:\n\n${body.lessonText}` }] 
      }];
    }

    if (!contents) {
      return { statusCode: 400, body: JSON.stringify({ error: "لا يوجد محتوى للتحليل" }) };
    }

    // Fix: Use 'gemini-3-flash-preview' for basic text tasks like summarization and Q&A.
    // Fix: Respect the dynamic responseSchema and systemInstruction sent by the client.
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: contents,
      config: {
        systemInstruction: body.systemInstruction || "أنت مساعد دراسي ذكي. قم بتحليل المرفقات المرفقة بدقة. قدم ملخصاً منظماً باستخدام **كلمة** للتمييز، ثم قدم 3 أسئلة اختيار من متعدد مع التوضيح. أجب دائماً بتنسيق JSON.",
        responseMimeType: "application/json",
        responseSchema: body.responseSchema || {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            quizzes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  options: { type: Type.ARRAY, items: { type: Type.STRING } },
                  correctAnswer: { type: Type.INTEGER },
                  explanation: { type: Type.STRING }
                },
                required: ["question", "options", "correctAnswer", "explanation"]
              }
            }
          },
          required: ["summary", "quizzes"]
        }
      },
    });

    // Fix: Access the text directly from the response object as a property, not a method.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: response.text }),
    };
  } catch (error: any) {
    console.error("Gemini Proxy Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "حدث خطأ أثناء الاتصال بالذكاء الاصطناعي" }),
    };
  }
};
