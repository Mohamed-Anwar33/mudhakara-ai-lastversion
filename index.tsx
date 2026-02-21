
import React, { Component, ReactNode, ErrorInfo } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

/**
 * تهيئة بيئة التشغيل لمتغيرات Netlify/Vite
 * تم إزالة VITE_GEMINI_API_KEY من هنا لضمان الأمان ونقل العمليات للخادم
 */
if (typeof window !== 'undefined') {
  const env = (import.meta as any).env || {};
  (window as any).process = {
    env: {
      VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
      ...env
    }
  };
}

console.log("🚀 [Mudhakara] System Initialized with Secure Proxy Architecture");

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/**
 * ErrorBoundary Component
 * معالجة الأخطاء الشاملة للتطبيق
 */
// Fix: Use React.Component explicitly and implement a constructor to ensure props and state are correctly inherited and typed.
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("❌ [Critical App Failure]:", error, errorInfo);
  }

  render() {
    // Fix: Accessing state and props via 'this' as members inherited from React.Component.
    if (this.state.hasError) {
      return (
        <div style={{ 
          display: 'flex', flexDirection: 'column', alignItems: 'center', 
          justifyContent: 'center', height: '100vh', padding: '20px', 
          textAlign: 'center', fontFamily: 'Cairo, sans-serif', direction: 'rtl',
          background: '#fff1f2'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>⚠️</div>
          <h1 style={{ color: '#be123c', fontWeight: '900', fontSize: '24px' }}>حدث خطأ غير متوقع</h1>
          <p style={{ color: '#4b5563', maxWidth: '400px', margin: '15px 0' }}>{this.state.error?.message || "فشل النظام في التحميل"}</p>
          <button 
            onClick={() => window.location.reload()} 
            style={{ padding: '14px 28px', background: '#4f46e5', color: 'white', borderRadius: '15px', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px', boxShadow: '0 10px 20px rgba(79,70,229,0.2)' }}
          >
            إعادة تحميل التطبيق
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
