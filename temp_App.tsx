
import * as React from 'react';
import { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';
import Auth from './pages/Auth.tsx';
import Dashboard from './pages/Dashboard.tsx';
import SubjectDetail from './pages/SubjectDetail.tsx';
import LessonDetail from './pages/LessonDetail.tsx';
import SubscriptionRequest from './pages/SubscriptionRequest.tsx';
import { Subject, User } from './types.ts';
import { fetchSubjects, upsertSubject, removeSubject, supabase, signOut } from './services/supabaseService.ts';

const App: React.FC = () => {
  const [isInitializing, setIsInitializing] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);

  useEffect(() => {
    // Safe initialization check
    if (!supabase) {
      console.warn("Supabase client not initialized. Check environment variables.");
      setIsInitializing(false);
      return;
    }

    // 1. Check active session
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.error("Session check error:", error);
      }
      const session = data?.session;
      setSession(session);
      if (session) fetchUserData(session.user.id);
    }).catch(err => {
      console.error("Unexpected error checking session:", err);
    }).finally(() => {
      setIsInitializing(false);
    });

    // 2. Listen for auth changes
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        fetchUserData(session.user.id);
      } else {
        setSubjects([]); // Clear data on logout
      }
    });

    return () => data?.subscription.unsubscribe();
  }, []);

  const fetchUserData = async (userId: string) => {
    try {
      const cloudSubjects = await fetchSubjects();
      setSubjects(cloudSubjects || []);
    } catch (e) {
      console.error("Error fetching data:", e);
    }
  };

  const handleLogout = async () => {
    await signOut();
    setSession(null);
    setSubjects([]);
  };

  const addSubject = async (name: string, code: string, description?: string) => {
    if (!session?.user) return;

    const newSubject: Subject = {
      id: crypto.randomUUID(),
      user_id: session.user.id, // Explicitly link to current user
      name,
      code,
      university: "جامعة افتراضية", // Default for now
      description
    };
    try {
      await upsertSubject(newSubject);
      setSubjects(prev => [...prev, newSubject]);
      toast.success("تم إضافة المادة بنجاح");
    } catch (e) { toast.error("فشل في مزامنة المادة مع السحابة"); }
  };

  const updateSubject = async (id: string, name: string, code: string, description?: string) => {
    if (!session?.user) return;
    const target = subjects.find(s => s.id === id);
    if (!target) return;

    const updatedSubject = { ...target, name, code, description, user_id: session.user.id };
    try {
      await upsertSubject(updatedSubject);
      setSubjects(prev => prev.map(s => s.id === id ? updatedSubject : s));
      toast.success("تم تحديث المادة بنجاح");
    } catch (e) { toast.error("فشل في تحديث المادة سحابياً"); }
  };

  const deleteSubject = async (id: string) => {
    try {
      await removeSubject(id);
      setSubjects(prev => prev.filter(s => s.id !== id));
      toast.success("تم حذف المادة بنجاح");
    } catch (e) { toast.error("فشل في حذف المادة من السحابة"); }
  };

  if (isInitializing) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-950 text-indigo-500 font-['Cairo']">
        <div className="w-12 h-12 border-4 border-indigo-900 border-t-indigo-500 rounded-full animate-spin mb-6"></div>
        <p className="font-black text-lg animate-pulse">جاري الاتصال بالسحابة...</p>
      </div>
    );
  }

  // Derived user object for Dashboard
  const dashboardUser: User = session ? {
    id: session.user.id,
    name: session.user.email?.split('@')[0] || 'User',
    email: session.user.email || '',
    picture: ''
  } : { name: '', email: '', picture: '' };

  return (
    <Router>
      <div className="min-h-screen bg-slate-950 font-sans text-slate-100" dir="rtl">
        <Toaster
          position="top-center"
          reverseOrder={false}
          toastOptions={{
            style: {
              background: '#1e293b',
              color: '#fff',
              borderRadius: '1rem',
              border: '1px solid #334155',
              padding: '16px',
              fontFamily: 'Cairo, sans-serif',
              fontSize: '0.875rem',
              fontWeight: 600,
            },
            success: {
              iconTheme: {
                primary: '#10b981',
                secondary: '#ecfdf5',
              },
            },
            error: {
              iconTheme: {
                primary: '#ef4444',
                secondary: '#fef2f2',
              },
            },
          }}
        />
        <Routes>
          <Route path="/" element={<SubscriptionRequest />} />

          <Route path="/login" element={!session ? <Auth /> : <Navigate to="/dashboard" replace />} />

          <Route path="/dashboard" element={
            session ? (
              <Dashboard
                subjects={subjects}
                onAddSubject={addSubject}
                onDeleteSubject={deleteSubject}
                onUpdateSubject={updateSubject}
                university="منصتي"
                user={dashboardUser}
                onLogout={handleLogout}
              />
            ) : <Navigate to="/login" replace />
          } />

          <Route path="/subject/:id" element={session ? <SubjectDetail subjects={subjects} setSubjects={setSubjects} user={dashboardUser} /> : <Navigate to="/login" replace />} />
          <Route path="/lesson/:lessonId" element={session ? <LessonDetail /> : <Navigate to="/login" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </Router>
  );
};

export default App;
