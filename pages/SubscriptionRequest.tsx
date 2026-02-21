
import React, { useState, useRef } from 'react';
import {
  User, Phone, GraduationCap, Layers, CheckCircle2,
  Sparkles, BookOpen, Brain, Zap, ShieldCheck,
  ChevronDown, MessageSquare, ArrowDown, Plus, Minus,
  Lock, Globe, Star, Info
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const SubscriptionRequest: React.FC = () => {
  const navigate = useNavigate();
  const formRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [subjectsCount, setSubjectsCount] = useState(5);

  const [formData, setFormData] = useState({
    fullName: '',
    phone: '',
    major: '',
  });

  const scrollToForm = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // محاكاة إرسال الطلب عبر واتساب
    setTimeout(() => {
      const message = `مرحباً، أود الاشتراك في باقة النخبة.\nالاسم: ${formData.fullName}\nالجوال: ${formData.phone}\nالتخصص: ${formData.major}\nعدد المواد: ${subjectsCount}`;
      window.open(`https://wa.me/966554889296?text=${encodeURIComponent(message)}`, '_blank');
      setIsLoading(false);
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white font-['Cairo'] selection:bg-sky-500/30 overflow-x-hidden" dir="rtl">

      {/* --- الخلفية المتحركة --- */}
      <div className="fixed inset-0 z-0">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-sky-500/10 rounded-full blur-[120px] -mr-64 -mt-64 animate-pulse"></div>
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-blue-600/10 rounded-full blur-[120px] -ml-64 -mb-64"></div>
      </div>

      {/* --- الهيدر --- */}
      <nav className="relative z-50 flex items-center justify-between px-6 py-8 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-sky-400 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-sky-500/20">
            <GraduationCap className="text-white" size={24} />
          </div>
          <span className="text-2xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-sky-300">مذاكرة</span>
        </div>
        <button
          onClick={() => navigate('/login')}
          className="bg-white/5 backdrop-blur-md border border-white/10 px-6 py-2.5 rounded-2xl font-bold text-sm hover:bg-white/10 transition-all flex items-center gap-2"
        >
          <span>تسجيل دخول</span>
          <Lock size={14} />
        </button>
      </nav>

      {/* --- Hero Section --- */}
      <section className="relative z-10 pt-20 pb-32 px-6 max-w-7xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 bg-sky-500/10 border border-sky-500/20 px-4 py-2 rounded-full mb-8 animate-bounce">
          <Sparkles className="text-sky-400" size={14} />
          <span className="text-[11px] font-black text-sky-300 uppercase tracking-widest">مخصص حالياً لطلاب جامعة القصيم</span>
        </div>

        <h1 className="text-5xl md:text-7xl font-black mb-6 leading-[1.2] bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-sky-400/50">
          انضم إلى باقة <br /> <span className="text-sky-400">النخبة الذكية</span>
        </h1>

        <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto mb-12 font-bold leading-relaxed">
          استمتع بتجربة دراسة ذكية بلا حدود، حيث يحول الذكاء الاصطناعي محتواك الدراسي إلى ملخصات واختبارات تفاعلية في ثوانٍ.
        </p>

        <div className="flex flex-col md:flex-row items-center justify-center gap-6 mb-20">
          <button
            onClick={scrollToForm}
            className="group relative bg-sky-500 hover:bg-sky-400 text-slate-950 font-black px-10 py-5 rounded-[2rem] text-xl transition-all shadow-2xl shadow-sky-500/25 flex items-center gap-3 active:scale-95"
          >
            <span>ابدأ رحلتك الآن</span>
            <ArrowDown className="group-hover:translate-y-1 transition-transform" />
          </button>
        </div>

        {/* بطاقات المميزات السريعة */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {[
            { title: "تلخيص ذكي", desc: "استخراج الأفكار الرئيسية من محاضراتك وصورك بدقة.", icon: <Brain className="text-sky-400" /> },
            { title: "اختبارات تفاعلية", desc: "إنشاء أسئلة محاكية لاختباراتك الفعلية للتدريب.", icon: <Zap className="text-amber-400" /> },
            { title: "حل الواجبات", desc: "مساعدة ذكية في حل المسائل مع شرح الخطوات.", icon: <BookOpen className="text-blue-400" /> }
          ].map((item, idx) => (
            <div key={idx} className="bg-white/5 backdrop-blur-xl border border-white/10 p-8 rounded-[2.5rem] text-right hover:border-sky-500/30 transition-all group">
              <div className="w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                {item.icon}
              </div>
              <h3 className="text-xl font-black mb-3">{item.title}</h3>
              <p className="text-slate-400 text-sm font-bold leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- نموذج الاشتراك --- */}
      <section ref={formRef} className="relative z-10 py-32 px-6 bg-gradient-to-b from-transparent via-blue-900/20 to-transparent">
        <div className="max-w-3xl mx-auto">
          <div className="bg-white rounded-[3.5rem] p-10 md:p-16 shadow-[0_40px_100px_rgba(0,0,0,0.4)] border border-white/10 text-slate-900 relative overflow-hidden">

            <div className="relative z-10">
              <div className="flex items-center gap-4 mb-10">
                <div className="w-14 h-14 bg-sky-100 text-sky-600 rounded-2xl flex items-center justify-center shadow-inner">
                  <Star size={32} />
                </div>
                <div className="text-right">
                  <h2 className="text-3xl font-black">طلب الانضمام</h2>
                  <p className="text-slate-400 font-bold text-sm">احصل على تسعيرتك المخصصة خلال دقائق</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm font-black text-slate-500 mr-2">
                      <User size={16} className="text-sky-500" /> الاسم الكامل
                    </label>
                    <input
                      required
                      type="text"
                      placeholder="أدخل اسمك الثلاثي"
                      value={formData.fullName}
                      onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                      className="w-full p-5 bg-slate-50 border-2 border-slate-50 rounded-2xl outline-none focus:border-sky-500 focus:bg-white transition-all font-bold"
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm font-black text-slate-500 mr-2">
                      <Phone size={16} className="text-sky-500" /> رقم الجوال
                    </label>
                    <input
                      required
                      type="tel"
                      placeholder="05xxxxxxxx"
                      dir="ltr"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full p-5 bg-slate-50 border-2 border-slate-50 rounded-2xl outline-none focus:border-sky-500 focus:bg-white transition-all font-bold text-right"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-sm font-black text-slate-500 mr-2">
                    <GraduationCap size={16} className="text-sky-500" /> التخصص الجامعي
                  </label>
                  <input
                    required
                    type="text"
                    placeholder="مثال: هندسة برمجيات، طب بشري..."
                    value={formData.major}
                    onChange={(e) => setFormData({ ...formData, major: e.target.value })}
                    className="w-full p-5 bg-slate-50 border-2 border-slate-50 rounded-2xl outline-none focus:border-sky-500 focus:bg-white transition-all font-bold"
                  />
                </div>

                <div className="space-y-5 bg-slate-50 p-8 rounded-3xl border border-slate-100">
                  <div className="flex items-center justify-between">
                    <div className="text-right">
                      <h4 className="font-black text-slate-800">عدد المواد</h4>
                      <p className="text-[11px] font-bold text-slate-400">اختر عدد المواد التي ترغب بتفعيلها</p>
                    </div>
                    <div className="flex items-center gap-6">
                      <button
                        type="button"
                        onClick={() => setSubjectsCount(Math.max(1, subjectsCount - 1))}
                        className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-slate-400 hover:text-sky-500 shadow-sm border border-slate-100 transition-all"
                      >
                        <Minus size={20} />
                      </button>
                      <span className="text-3xl font-black text-sky-600 w-8 text-center">{subjectsCount}</span>
                      <button
                        type="button"
                        onClick={() => setSubjectsCount(subjectsCount + 1)}
                        className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-slate-400 hover:text-sky-500 shadow-sm border border-slate-100 transition-all"
                      >
                        <Plus size={20} />
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-slate-900 text-white font-black py-6 rounded-[2rem] shadow-2xl flex items-center justify-center gap-4 hover:bg-sky-600 transition-all active:scale-95 disabled:opacity-50"
                >
                  <span className="text-xl">احسب التسعيرة وأرسلها لي</span>
                  <MessageSquare size={24} />
                </button>

                <p className="text-center text-slate-400 text-xs font-bold flex items-center justify-center gap-2">
                  <CheckCircle2 size={14} className="text-emerald-500" />
                  سيتم إرسال عرض السعر عبر واتساب لأننا في المرحلة التجريبية
                </p>
              </form>
            </div>
          </div>
        </div>
      </section>

      {/* --- الأقسام الإضافية --- */}
      <section className="relative z-10 py-32 px-6 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">

          {/* ما هي مذاكرة */}
          <div className="bg-white/5 backdrop-blur-md border border-white/10 p-12 rounded-[3.5rem] text-right">
            <h2 className="text-3xl font-black mb-6 flex items-center justify-end gap-3 text-sky-300">
              ما هي مذاكرة؟
              <Info size={28} />
            </h2>
            <p className="text-slate-400 font-bold leading-relaxed text-lg">
              مذاكرة هي منصة تعليمية ذكية تعتمد على تقنيات <span className="text-white">الذكاء الاصطناعي التوليدي</span> لمساعدة الطلاب على إدارة محتواهم الدراسي بفعالية. نحن لسنا مجرد موقع للتخزين، بل نحن "عقلك الرقمي" الذي يقرأ، يحلل، ويختبرك في موادك الدراسية.
            </p>
          </div>

          {/* لماذا نحن مختلفون */}
          <div className="space-y-6">
            <h2 className="text-3xl font-black mb-8 text-right px-4">لماذا نحن مختلفون؟</h2>
            {[
              { t: "دقة متناهية", d: "خوارزميات مخصصة للغة العربية والأكاديمية.", i: <Globe size={20} /> },
              { t: "خصوصية كاملة", d: "بياناتك ومحتواك الدراسي مشفر وآمن تماماً.", i: <ShieldCheck size={20} /> },
              { t: "توفير 80% من الوقت", d: "حوّل 100 صفحة إلى ملخص في دقيقتين.", i: <Zap size={20} /> }
            ].map((item, idx) => (
              <div key={idx} className="flex items-center gap-6 p-6 bg-white/5 border border-white/10 rounded-3xl text-right">
                <div className="flex-1">
                  <h4 className="font-black text-white mb-1">{item.t}</h4>
                  <p className="text-slate-400 text-xs font-bold">{item.d}</p>
                </div>
                <div className="w-12 h-12 bg-sky-500/10 text-sky-400 rounded-2xl flex items-center justify-center shrink-0">
                  {item.i}
                </div>
              </div>
            ))}
          </div>

        </div>

        {/* قسم الخصوصية */}
        <div className="mt-20 p-10 bg-gradient-to-r from-blue-900/20 to-sky-900/20 border border-white/5 rounded-[3rem] text-center">
          <ShieldCheck className="mx-auto mb-6 text-sky-400" size={48} />
          <h3 className="text-2xl font-black mb-4">التزامنا بالخصوصية</h3>
          <p className="text-slate-400 font-bold max-w-2xl mx-auto leading-relaxed">
            نحن نؤمن بأن المحتوى التعليمي هو ملك للطالب. نؤكد لك أن بياناتك لا تُشارك مع أي جهة خارجية، ولا تُستخدم لتدريب النماذج العامة. دراستك، أبحاثك، وكتبك تبقى في بيئة مشفرة خاصة بك فقط.
          </p>
        </div>
      </section>

      {/* --- الفوتر --- */}
      <footer className="relative z-10 py-20 border-t border-white/5 text-center">
        <div className="flex items-center justify-center gap-3 mb-6">
          <GraduationCap className="text-sky-400" size={24} />
          <span className="text-xl font-black">مذاكرة</span>
        </div>
        <p className="text-slate-500 text-xs font-bold mb-4">نصنع مستقبل التعليم في المملكة العربية السعودية 🇸🇦</p>
        <p className="text-slate-600 text-[10px] font-black uppercase tracking-widest">جميع الحقوق محفوظة © 2025</p>
      </footer>
    </div>
  );
};

export default SubscriptionRequest;
