'use client';

import { LogIn } from 'lucide-react';

export default function LoginPage() {
  const handleLogin = () => {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:8000';
    window.location.href = `${backendUrl}/auth/login`;
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
      <div className="p-8 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl w-full max-w-md text-center">
        <h1 className="text-3xl font-bold mb-6">Welcome to AI Chat</h1>
        <p className="text-zinc-500 dark:text-zinc-400 mb-8">
          Sign in with your Google account to start chatting with Gemini and OpenAI.
        </p>
        <button
          onClick={handleLogin}
          className="flex items-center justify-center w-full py-3 px-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-lg font-medium hover:opacity-90 transition-opacity gap-2"
        >
          <LogIn size={20} />
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
