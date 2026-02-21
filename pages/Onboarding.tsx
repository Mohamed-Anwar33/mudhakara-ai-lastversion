
import React, { useState, useEffect, useRef } from 'react';
import { GraduationCap, ArrowLeft, LogIn, CheckCircle2, Mail, KeyRound, RefreshCcw, Loader2, Edit3, ChevronDown, Lock, Send, X } from 'lucide-react';
import { User } from '../types';

interface OnboardingProps {
  onComplete: (university: string, user: User) => void;
}

const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [step, setStep] = useState<'email' | 'otp' | 'university'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [selectedUni, setSelectedUni] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showOtherUniModal, setShowOtherUniModal] = useState(false);
  const [otherUniName, setOtherUniName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [resendTimer, setResendTimer] = useState(30);

  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const universities = [
    { id: 'qu', name: 'جامعة القصيم', status: 'available' },
    { id: 'ksu', name: 'جامعة الملك سعود', status: 'soon' },
    { id: 'kau', name: 'جامعة الملك عبدالعزيز', status: 'soon' },
  ];

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (step === 'otp' && resendTimer > 0) {
      interval = setInterval(() => {
        setResendTimer((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [step, resendTimer]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const maskEmail = (emailStr: string) => {
    const [name, domain] = emailStr.split('@');
    if (!domain) return emailStr;
    if (name.length <= 4) return `${name[0]}***${name[name.length - 1]}@${domain}`;
    return `${name.substring(0, 2)}***${name.substring(name.length - 2)}@${domain}`;
  };

  const handleSendCode = () => {
    if (!email.includes('@')) {
      alert('يرجى إدخال بريد إلكتروني صحيح');
      return;
    }
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
      setStep('otp');
      setResendTimer(30);
      setOtp(['', '', '', '', '', '']);
    }, 1200);
  };

  const handleOtpChange = (value: string, index: number) => {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);
    if (value && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleVerifyAndLogin = () => {
    const fullOtp = otp.join('');
    if (fullOtp.length < 6) return;
    setIsLoading(true);
    setTimeout(() => {
      const mockUser: User = {
        name: email.split('@')[0],
        email: email,
        picture: `https://api.dicebear.com/7.x/avataaars/svg?seed=${email}`
      };
      setUser(mockUser);
      setIsLoading(false);
      setStep('university');
    }, 1200);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleUniSelect = (uni: typeof universities[0]) => {
    if (uni.status === 'available') {
      setSelectedUni(uni.name);
      setIsDropdownOpen(false);
    }
  };

  const handleRequestUni = () => {
    if (otherUniName.trim()) {
      alert('تم إرسال طلبك بنجاح، سنعمل على إضافة جامعتك قريباً!');
      setShowOtherUniModal(false);
      setOtherUniName('');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gradient-to-br from-indigo-600 to-blue-700 text-white font-['Cairo']">
      <div className="w-full max-w-sm bg-white rounded-[2.5rem] p-8 md:p-10 text-slate-900 shadow-2xl transition-all border border-white/20 relative">
        
        {step === 'email' && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex justify-center mb-8">
              <div className="p-5 bg-indigo-50 rounded-3xl text-indigo-600 shadow-inner">
                <LogIn size={48} strokeWidth={2.5} />
              </div>
            </div>
            <h1 className="text-2xl font-black text-center mb-3 tracking-tight text-slate-800">مرحباً بك في مذاكرة</h1>
            <p className="text-slate-500 text-center text-sm mb-10 leading-relaxed">سجّل دخولك باستخدام بريدك الإلكتروني لبدء رحلتك الدراسية</p>
            <div className="space-y-6">
              <div>
                <label className="block text-xs font-bold text-slate-400 mb-2 mr-1 uppercase tracking-widest flex items-center gap-2">
                  <Mail size={14} />
                  البريد الإلكتروني
                </label>
                <input 
                  type="email" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="example@email.com"
                  dir="ltr"
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500 focus:bg-white focus:outline-none transition-all text-left font-bold"
                />
              </div>
              <button 
                onClick={handleSendCode}
                disabled={isLoading || !email || !email.includes('@')}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-4 rounded-2xl shadow-xl shadow-indigo-100 flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50 disabled:bg-slate-300"
              >
                {isLoading ? <Loader2 className="animate-spin" size={20} /> : <span>إرسال كود التحقق</span>}
              </button>
            </div>
          </div>
        )}

        {step === 'otp' && (
          <div className="animate-in fade-in slide-in-from-left-4 duration-500">
            <div className="flex justify-center mb-8">
              <div className="p-5 bg-emerald-50 rounded-3xl text-emerald-600 shadow-inner">
                <KeyRound size={48} strokeWidth={2.5} />
              </div>
            </div>
            <h1 className="text-2xl font-black text-center mb-3 tracking-tight text-slate-800">كود التحقق</h1>
            <p className="text-slate-500 text-center text-sm mb-10 leading-relaxed">
              أدخل الكود المرسل إلى <br/> 
              <span className="font-bold text-indigo-600" dir="ltr">{maskEmail(email)}</span>
            </p>
            <div className="space-y-8">
              <div className="flex justify-between gap-2" dir="ltr">
                {otp.map((digit, index) => (
                  <input
                    key={index}
                    // Fix: Wrapped ref assignment in braces to ensure callback returns void, fixing TS error.
                    ref={(el) => { otpRefs.current[index] = el; }}
                    type="text"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(e.target.value, index)}
                    onKeyDown={(e) => handleOtpKeyDown(e, index)}
                    className="w-10 h-14 md:w-12 md:h-16 text-center text-2xl font-black bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white focus:outline-none transition-all text-slate-800"
                  />
                ))}
              </div>
              <div className="space-y-4">
                <button 
                  onClick={handleVerifyAndLogin}
                  disabled={isLoading || otp.join('').length < 6}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-4 rounded-2xl shadow-xl shadow-indigo-100 flex items-center justify-center gap-3 transition-all active:scale-95 disabled:bg-slate-200 disabled:shadow-none"
                >
                  {isLoading ? <Loader2 className="animate-spin" size={20} /> : <span>تحقق</span>}
                </button>
                <div className="flex flex-col items-center gap-3">
                  {resendTimer > 0 ? (
                    <p className="text-[11px] font-bold text-slate-400">
                      لم يصلك الكود؟ إعادة الإرسال بعد {formatTime(resendTimer)}
                    </p>
                  ) : (
                    <button onClick={handleSendCode} className="text-indigo-600 font-black text-xs hover:underline flex items-center gap-2">
                      <RefreshCcw size={14} />
                      إعادة إرسال الكود
                    </button>
                  )}
                  <button onClick={() => setStep('email')} className="flex items-center gap-2 text-slate-400 font-bold text-[10px] hover:text-indigo-600 transition-colors bg-slate-50 px-3 py-1.5 rounded-full">
                    <Edit3 size={12} />
                    تغيير البريد الإلكتروني
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'university' && (
          <div className="animate-in fade-in zoom-in duration-500">
            <div className="flex items-center gap-3 mb-8 p-3 bg-indigo-50 rounded-2xl border border-indigo-100">
              <img src={user?.picture} alt="Profile" className="w-12 h-12 rounded-xl border-2 border-white shadow-sm" />
              <div className="flex-1">
                <p className="text-[10px] text-slate-400 font-black uppercase">أهلاً بك،</p>
                <p className="font-black text-indigo-700 truncate max-w-[140px]">{user?.name}</p>
              </div>
              <div className="text-emerald-500">
                <CheckCircle2 size={24} />
              </div>
            </div>

            <h2 className="text-xl font-black mb-2 text-slate-800">اختر جامعتك</h2>
            <p className="text-slate-500 mb-8 text-xs leading-relaxed">لنخصص لك تجربة الدراسة بناءً على نظام جامعتك</p>

            <div className="space-y-4 mb-10 relative" ref={dropdownRef}>
              <button 
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className={`w-full p-5 rounded-2xl border-2 flex items-center justify-between transition-all bg-slate-50 ${isDropdownOpen ? 'border-indigo-600 ring-4 ring-indigo-50' : 'border-slate-100'}`}
              >
                <div className="flex items-center gap-4">
                  <div className={`p-2 rounded-xl bg-white shadow-sm ${selectedUni ? 'text-indigo-600' : 'text-slate-300'}`}>
                    <GraduationCap size={20} />
                  </div>
                  <span className={`font-bold ${selectedUni ? 'text-slate-800' : 'text-slate-400'}`}>
                    {selectedUni || 'اضغط لاختيار الجامعة'}
                  </span>
                </div>
                <ChevronDown size={20} className={`text-slate-300 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {isDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden z-50 animate-in fade-in slide-in-from-top-2">
                  {universities.map((uni) => (
                    <button
                      key={uni.id}
                      onClick={() => handleUniSelect(uni)}
                      className={`w-full p-4 flex items-center justify-between hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 ${uni.status === 'soon' ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span className="font-bold text-slate-700 text-sm">{uni.name}</span>
                      {uni.status === 'soon' && (
                        <div className="flex items-center gap-1.5 bg-slate-100 text-slate-400 px-2 py-1 rounded-lg text-[9px] font-black uppercase">
                          <Lock size={10} />
                          قريباً
                        </div>
                      )}
                      {selectedUni === uni.name && <CheckCircle2 size={18} className="text-indigo-600" />}
                    </button>
                  ))}
                </div>
              )}

              <button 
                onClick={() => setShowOtherUniModal(true)}
                className="text-[11px] font-bold text-indigo-600 hover:underline mt-2 mr-2"
              >
                جامعتي غير موجودة؟
              </button>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep('otp')} className="p-4 bg-slate-50 text-slate-400 rounded-2xl hover:bg-slate-100 transition-colors">
                <ArrowLeft size={20} className="rotate-180" />
              </button>
              <button 
                onClick={() => user && onComplete(selectedUni, user)}
                disabled={!selectedUni}
                className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white font-black py-4 rounded-2xl shadow-xl shadow-indigo-100 flex items-center justify-center gap-3 transition-all active:scale-95"
              >
                <span>ابدأ رحلتك</span>
                <ArrowLeft size={20} />
              </button>
            </div>
          </div>
        )}

        {/* Other University Modal Overlay */}
        {showOtherUniModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[100] p-6 animate-in fade-in">
            <div className="bg-white w-full max-w-xs rounded-[2rem] p-8 shadow-2xl animate-in zoom-in duration-300 relative text-slate-900">
              <button onClick={() => setShowOtherUniModal(false)} className="absolute top-6 left-6 text-slate-300 hover:text-slate-600">
                <X size={20} />
              </button>
              <h3 className="text-lg font-black mb-2">اقترح جامعتك</h3>
              <p className="text-xs text-slate-500 mb-6 leading-relaxed">سنعمل على توفير نظام جامعتك في أقرب وقت ممكن</p>
              
              <div className="space-y-4">
                <input 
                  type="text"
                  value={otherUniName}
                  onChange={(e) => setOtherUniName(e.target.value)}
                  placeholder="اسم الجامعة..."
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none font-bold text-sm"
                />
                <button 
                  onClick={handleRequestUni}
                  disabled={!otherUniName.trim()}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-3 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 shadow-lg shadow-indigo-100"
                >
                  <Send size={16} />
                  <span>إرسال الطلب</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="mt-8 text-center text-[10px] text-slate-300 font-bold leading-relaxed">
          جميع الحقوق محفوظة لتطبيق "مذاكرة" © 2025
        </p>
      </div>
    </div>
  );
};

export default Onboarding;
