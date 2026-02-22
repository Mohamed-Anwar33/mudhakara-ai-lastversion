import * as React from 'react';
import { useState } from 'react';
import { signUp, signIn } from '../services/supabaseService';
import { Mail, Lock, Loader2, ArrowRight, UserPlus, LogIn, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import toast from 'react-hot-toast';

const Auth: React.FC = () => {
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const navigate = useNavigate();

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isLogin) {
                await signIn(email, password);
                toast.success('أهلاً بك! 👋 تم تسجيل الدخول');
            } else {
                const { session } = await signUp(email, password);
                if (session) {
                    toast.success('مرحباً بك في مذاكرة! 🌟 حسابك جاهز');
                    navigate('/dashboard');
                    return;
                } else {
                    // If session is null, it means Email Confirmation is enabled on Supabase
                    toast.success('تم إنشاء حسابك! 📧 راجع بريدك للتفعيل');
                    setIsLogin(true);
                    setLoading(false);
                    return;
                }
            }
            navigate('/dashboard');
        } catch (err: any) {
            let msg = err.message || 'حدث خطأ أثناء المصادقة';

            // Handle specific Supabase errors with friendly Arabic messages
            if (msg.includes('User already registered') || msg.includes('already exists')) {
                msg = 'هذا البريد الإلكتروني مسجل لدينا بالفعل. قم بتسجيل الدخول بدلاً من ذلك.';
            } else if (msg.includes('Invalid login credentials')) {
                msg = 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
            } else if (msg.includes('Password should be at least')) {
                msg = 'كلمة المرور ضعيفة جداً. يجب أن تتكون من 6 أحرف على الأقل.';
            }

            setError(msg);
            toast.error(msg);
        } finally {
            if (isLogin) setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4 font-['Cairo']">
            <div className="bg-white rounded-[2.5rem] p-8 md:p-12 w-full max-w-md shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-full h-2 bg-gradient-to-l from-indigo-500 to-purple-500"></div>

                <div className="text-center mb-10">
                    <h1 className="text-3xl font-black text-slate-800 mb-2">
                        {isLogin ? 'مرحباً، عبقري!' : 'انضم إلينا'}
                    </h1>
                    <p className="text-slate-500 font-bold text-sm">
                        {isLogin ? 'سجل دخولك لمتابعة رحلة التعلم' : 'أنشئ حسابك وابدأ رحلتك الآن'}
                    </p>
                </div>

                {error && (
                    <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600">
                        <AlertCircle size={20} className="shrink-0" />
                        <p className="text-xs font-bold">{error}</p>
                    </div>
                )}

                <form onSubmit={handleAuth} className="space-y-6">
                    <div className="space-y-4">
                        <div className="relative">
                            <Mail className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                            <input
                                type="email"
                                placeholder="البريد الإلكتروني"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="username"
                                className="w-full bg-slate-100 border-2 border-slate-100 rounded-2xl py-4 pr-12 pl-4 outline-none focus:border-indigo-500 focus:bg-white transition-all font-bold text-slate-900 placeholder:text-slate-400 text-right"
                                required
                            />
                        </div>
                        <div className="relative">
                            <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                            <input
                                type={showPassword ? "text" : "password"}
                                placeholder="كلمة المرور"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete={isLogin ? "current-password" : "new-password"}
                                className="w-full bg-slate-100 border-2 border-slate-100 rounded-2xl py-4 pr-12 pl-12 outline-none focus:border-indigo-500 focus:bg-white transition-all font-bold text-slate-900 placeholder:text-slate-400 text-right"
                                required
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-indigo-600 transition-colors focus:outline-none focus:text-indigo-600 p-1 rounded-lg"
                                title={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                            >
                                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                            </button>
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-slate-900 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-indigo-600 transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? <Loader2 className="animate-spin" /> : (isLogin ? <LogIn size={20} /> : <UserPlus size={20} />)}
                        <span>{isLogin ? 'تسجيل الدخول' : 'إنشاء حساب'}</span>
                    </button>
                </form>

                <div className="mt-8 text-center">
                    <button
                        onClick={() => { setIsLogin(!isLogin); setError(null); }}
                        className="text-indigo-600 font-bold text-sm hover:underline flex items-center justify-center gap-1 mx-auto"
                    >
                        {isLogin ? 'ليس لديك حساب؟ سجل الآن' : 'لديك حساب بالفعل؟ سجل دخولك'}
                        <ArrowRight size={16} className="rotate-180" />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Auth;
