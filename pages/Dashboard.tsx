
import React, { useState, useEffect, useRef } from 'react';
import {
  Plus, BookOpen, GraduationCap, X, LogOut, Menu, MoreVertical, Trash2, Edit2, AlertTriangle,
  CheckCircle2, Search, User as UserIcon, Database, Info, Gem, Zap, Sparkles, ChevronLeft
} from 'lucide-react';
import { Subject, User } from '../types.ts';
import { Link, useNavigate } from 'react-router-dom';
import { testSupabaseConnection, upsertSubject, removeSubject } from '../services/supabaseService.ts';

interface DashboardProps {
  subjects?: Subject[];
  onAddSubject: (name: string, code: string, description?: string) => void;
  onDeleteSubject: (id: string) => void;
  onUpdateSubject: (id: string, name: string, code: string, description?: string) => void;
  university: string;
  user?: User;
  onLogout: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ subjects = [], onAddSubject, onDeleteSubject, onUpdateSubject, university, user, onLogout }) => {
  const navigate = useNavigate();
  const [showModal, setShowModal] = useState(false);
  const [modalView, setModalView] = useState<'form' | 'edit'>('form');
  const [showSidebar, setShowSidebar] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [newSubjectName, setNewSubjectName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [codeNumber, setCodeNumber] = useState('');

  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [subjectToDelete, setSubjectToDelete] = useState<Subject | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const safeSubjects = Array.isArray(subjects) ? subjects : [];
  const filteredSubjects = safeSubjects.filter(s =>
    (s?.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s?.code || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleAction = async () => {
    const finalCode = (codePrefix + " " + codeNumber).toUpperCase().trim() || "GEN 000";

    try {
      if (modalView === 'edit' && editingSubjectId) {
        onUpdateSubject(editingSubjectId, newSubjectName.trim(), finalCode, newDescription);
        showToast("تم تحديث المادة بنجاح");
      } else if (newSubjectName.trim()) {
        onAddSubject(newSubjectName.trim(), finalCode, newDescription);
        showToast("تمت إضافة المادة بنجاح");
      }
      resetForm();
    } catch (e) {
      showToast("فشل في حفظ البيانات");
    }
  };

  const resetForm = () => {
    setNewSubjectName(''); setCodePrefix(''); setCodeNumber(''); setNewDescription('');
    setEditingSubjectId(null); setShowModal(false); setModalView('form');
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 font-['Cairo'] pb-20">
      {toastMessage && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[200] bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4">
          <CheckCircle2 className="text-emerald-400" size={20} />
          <span className="font-bold text-sm">{toastMessage}</span>
        </div>
      )}

      {showSidebar && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[150]" onClick={() => setShowSidebar(false)}>
          <div className="absolute right-0 top-0 h-full w-full max-w-[280px] bg-white p-8 animate-in slide-in-from-right duration-300 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-10 text-indigo-600">
              <GraduationCap size={32} />
              <h2 className="text-2xl font-black">مذاكرة</h2>
            </div>

            <div className="mb-6 p-4 bg-slate-50 rounded-2xl flex items-center gap-3">
              {user?.picture ? (
                <img src={user.picture} alt="" className="w-10 h-10 rounded-full" />
              ) : (
                <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center"><UserIcon size={20} /></div>
              )}
              <div className="overflow-hidden">
                <p className="font-bold text-sm truncate">{user?.name || "طالب مذاكرة"}</p>
                <p className="text-[10px] text-slate-400 truncate">{user?.email}</p>
              </div>
            </div>

            <div className="flex-1 space-y-3">
              <Link to="/subscription" onClick={() => setShowSidebar(false)} className="w-full flex items-center justify-between p-4 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-black transition-all text-sm shadow-lg shadow-indigo-100">
                <div className="flex items-center gap-3">
                  <Gem size={18} />
                  <span>باقة النخبة</span>
                </div>
                <ChevronLeft size={16} />
              </Link>


            </div>

            <button onClick={onLogout} className="w-full flex items-center gap-4 p-4 rounded-2xl text-red-500 hover:bg-red-50 font-bold transition-all text-sm mt-auto">
              <LogOut size={20} />
              <span>تسجيل الخروج</span>
            </button>
          </div>
        </div>
      )}

      <header className="mb-10">
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-4">
            <button onClick={() => setShowSidebar(true)} className="p-3 bg-white border border-slate-100 rounded-2xl shadow-sm hover:bg-slate-50 transition-colors">
              <Menu size={24} />
            </button>
            <div className="text-right">
              <h1 className="text-2xl font-black text-slate-800">حقيبتي الدراسية</h1>
              <p className="text-xs text-slate-400 font-bold">{university} • {safeSubjects.length} مواد</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link to="/subscription" className="hidden md:flex items-center gap-2 bg-amber-50 text-amber-600 px-5 py-3 rounded-2xl border border-amber-100 font-black text-xs hover:bg-amber-100 transition-all shadow-sm">
              <Gem size={16} />
              <span>الاشتراك الذهبي</span>
            </Link>
            <button onClick={() => setShowModal(true)} className="bg-indigo-600 text-white p-4 rounded-2xl shadow-lg shadow-indigo-100 hover:scale-105 transition-all">
              <Plus size={24} strokeWidth={3} />
            </button>
          </div>
        </div>

        {/* كرت الترقية المميز للموبايل */}
        <Link to="/subscription" className="md:hidden mb-8 w-full p-5 bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 rounded-[2rem] shadow-xl shadow-indigo-100 flex items-center justify-between text-white animate-in slide-in-from-bottom-2 duration-700">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center text-amber-300">
              <Sparkles size={24} />
            </div>
            <div className="text-right">
              <p className="font-black text-sm">ترقية لباقة النخبة الذكية</p>
              <p className="text-[10px] font-bold opacity-80">احصل على قدرات AI بلا حدود</p>
            </div>
          </div>
          <ChevronLeft size={20} />
        </Link>

        <div className="relative group">
          <Search className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-indigo-500 transition-colors" size={20} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث عن مادة باسمها أو رمزها..."
            className="w-full bg-white border border-slate-100 rounded-[1.5rem] py-5 pr-14 pl-6 font-bold text-sm shadow-sm focus:ring-4 focus:ring-indigo-50 outline-none transition-all text-right text-slate-900 placeholder:text-slate-400"
          />
        </div>
      </header>

      {filteredSubjects.length === 0 ? (
        <div className="py-20 text-center flex flex-col items-center animate-in fade-in">
          <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center text-slate-300 mb-6">
            <BookOpen size={48} />
          </div>
          <h2 className="text-xl font-black text-slate-400">لا يوجد مواد حالياً</h2>
          <p className="text-sm text-slate-300 mt-2">اضغط على زر (+) لإضافة أول مادة دراسية لك</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSubjects.map(subject => (
            <div key={subject.id} className="relative group">
              <Link to={`/subject/${subject.id}`} className="block bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 hover:shadow-xl hover:border-indigo-100 transition-all text-right">
                <div className="flex justify-between items-start mb-6">
                  <div className="p-3 bg-indigo-50 text-indigo-600 rounded-2xl group-hover:bg-indigo-600 group-hover:text-white transition-all">
                    <BookOpen size={24} />
                  </div>
                  <span className="text-[10px] font-black bg-slate-50 text-slate-400 px-3 py-1.5 rounded-full uppercase tracking-widest">{subject.code}</span>
                </div>
                <h3 className="text-lg font-black text-slate-800 mb-1 truncate">{subject.name}</h3>
                <p className="text-[10px] font-bold text-slate-400 line-clamp-1">{subject.description || "اضغط للمذاكرة الذكية"}</p>
              </Link>

              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveMenuId(activeMenuId === subject.id ? null : subject.id); }}
                className="absolute top-8 left-8 p-2 text-slate-300 hover:text-slate-600 z-20 hover:bg-slate-50 rounded-full transition-all"
              >
                <MoreVertical size={20} />
              </button>

              {activeMenuId === subject.id && (
                <div ref={menuRef} className="absolute top-16 left-8 bg-white rounded-2xl shadow-2xl border border-slate-100 py-2 z-[100] w-44 animate-in zoom-in duration-200">
                  <button onClick={(e) => {
                    e.stopPropagation();
                    setEditingSubjectId(subject.id);
                    setNewSubjectName(subject.name);
                    setNewDescription(subject.description || '');
                    const parts = subject.code.split(' ');
                    setCodePrefix(parts[0] || '');
                    setCodeNumber(parts[1] || '');
                    setModalView('edit');
                    setShowModal(true);
                    setActiveMenuId(null);
                  }} className="w-full px-4 py-3 text-right text-slate-600 hover:bg-slate-50 font-bold text-xs flex items-center justify-end gap-3 transition-colors">
                    <span>تعديل المادة</span>
                    <Edit2 size={14} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setSubjectToDelete(subject); setActiveMenuId(null); }} className="w-full px-4 py-3 text-right text-red-500 hover:bg-red-50 font-bold text-xs flex items-center justify-end gap-3 transition-colors border-t border-slate-50">
                    <span>حذف المادة</span>
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[200] p-4">
          <div className="bg-white w-full max-w-lg rounded-[3rem] p-8 md:p-10 shadow-2xl relative animate-in zoom-in">
            <button onClick={resetForm} className="absolute top-8 left-8 text-slate-300 hover:text-slate-600">
              <X size={24} />
            </button>
            <div className="text-right">
              <h2 className="text-2xl font-black text-slate-800 mb-8">{modalView === 'edit' ? 'تعديل بيانات المادة' : 'إضافة مادة جديدة'}</h2>
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-black text-slate-400 mb-2 mr-2 uppercase tracking-widest">رمز المادة</label>
                    <input type="text" value={codePrefix} onChange={(e) => setCodePrefix(e.target.value.toUpperCase())} placeholder="MATH" className="w-full p-4 bg-slate-100 border-2 border-slate-200 rounded-2xl outline-none font-black text-center text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-indigo-500 transition-all" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-slate-400 mb-2 mr-2 uppercase tracking-widest">الرقم</label>
                    <input type="text" value={codeNumber} onChange={(e) => setCodeNumber(e.target.value)} placeholder="101" className="w-full p-4 bg-slate-100 border-2 border-slate-200 rounded-2xl outline-none font-black text-center text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-indigo-500 transition-all" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-400 mb-2 mr-2">اسم المادة</label>
                  <input type="text" value={newSubjectName} onChange={(e) => setNewSubjectName(e.target.value)} placeholder="مثال: مبادئ قواعد البيانات" className="w-full p-4 bg-slate-100 border-2 border-slate-200 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-indigo-500 transition-all" />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-400 mb-2 mr-2">وصف قصير (اختياري)</label>
                  <textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="اكتب نبذة بسيطة عن المادة..." className="w-full p-4 bg-slate-100 border-2 border-slate-200 rounded-2xl outline-none font-bold text-right text-slate-900 placeholder:text-slate-400 h-24 resize-none focus:bg-white focus:border-indigo-500 transition-all" />
                </div>
                <button onClick={handleAction} className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2">
                  {modalView === 'edit' ? <CheckCircle2 size={20} /> : <Plus size={20} />}
                  <span>{modalView === 'edit' ? 'حفظ التغييرات' : 'إضافة المادة'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subjectToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[210] p-4">
          <div className="bg-white w-full max-w-sm rounded-[3rem] p-10 shadow-2xl text-center">
            <div className="w-20 h-20 bg-red-50 text-red-500 rounded-3xl flex items-center justify-center mx-auto mb-6 animate-bounce"><AlertTriangle size={40} /></div>
            <h2 className="text-2xl font-black text-slate-800 mb-4">حذف المادة؟</h2>
            <p className="text-xs text-slate-500 mb-10 leading-relaxed">سيتم حذف المادة وكل الدروس والواجبات المرتبطة بها نهائياً. لا يمكن التراجع عن هذا الإجراء.</p>
            <div className="flex flex-col gap-3">
              <button onClick={() => { onDeleteSubject(subjectToDelete.id); setSubjectToDelete(null); showToast("تم حذف المادة"); }} className="w-full bg-red-500 text-white font-black py-4 rounded-2xl shadow-xl hover:bg-red-600 transition-all">نعم، حذف نهائي</button>
              <button onClick={() => setSubjectToDelete(null)} className="w-full bg-slate-100 text-slate-500 font-black py-4 rounded-2xl hover:bg-slate-200 transition-all">إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
