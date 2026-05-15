'use client';

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import { Send, User as UserIcon, Bot, LogOut, Plus, MessageSquare, Trash2, BarChart } from 'lucide-react';

// FORCE IPv4 address to avoid localhost IPv6/CORS confusion
const API_BASE = 'http://127.0.0.1:8000';
const WS_BASE = 'ws://127.0.0.1:8000';

const subscribeToHydration = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Conversation {
  id: number;
  title: string;
  updated_at: string;
}

interface UserStats {
  name: string;
  email: string;
  picture: string;
  last_active: string;
  total_requests: number;
  total_tokens_used: number;
}

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<UserStats | null>(null);
  const [provider, setProvider] = useState<'gemini' | 'openai'>('gemini');
  const [showSidebar, setShowSidebar] = useState(true);
  const hasMounted = useSyncExternalStore(subscribeToHydration, getClientSnapshot, getServerSnapshot);
  
  const ws = useRef<WebSocket | null>(null);
  const pendingMessageRef = useRef<{ conversationId: number; content: string } | null>(null);
  const streamSessionRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const isSendDisabled = !hasMounted || !input.trim() || loading;

  const getHeaders = useCallback(() => {
    const token = localStorage.getItem('token');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }, []);

  const fetchConversations = useCallback(async () => {
    try {
        const res = await fetch(`${API_BASE}/conversations`, { headers: getHeaders() });
        if (res.ok) setConversations(await res.json());
    } catch (e) { console.error(e); }
  }, [getHeaders]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }

    const fetchData = async () => {
      try {
        const statsRes = await fetch(`${API_BASE}/user/stats`, { headers: getHeaders() });
        const convsRes = await fetch(`${API_BASE}/conversations`, { headers: getHeaders() });
        
        if (statsRes.ok) setUser(await statsRes.json());
        if (convsRes.ok) setConversations(await convsRes.json());
      } catch (err) {
        console.error("Connection Error:", err);
      }
    };
    fetchData();
  }, [router, getHeaders]);

  // Handle conversation switching
  useEffect(() => {
    if (!activeConvId) {
      if (ws.current) ws.current.close();
      return;
    }

    const streamSession = ++streamSessionRef.current;

    // Fetch messages for active conversation
    fetch(`${API_BASE}/conversations/${activeConvId}/messages`, { headers: getHeaders() })
      .then(res => res.ok ? res.json() : [])
      .then(data => setMessages(data))
      .catch(err => console.error(err));

    // Setup WebSocket for active conversation
    if (ws.current) ws.current.close();
    const socket = new WebSocket(`${WS_BASE}/chat`);
    ws.current = socket;

    socket.onopen = () => {
      if (streamSession !== streamSessionRef.current) return;
      const token = localStorage.getItem('token');
      socket.send(JSON.stringify({ token, provider, conversation_id: activeConvId }));
      if (
        pendingMessageRef.current &&
        pendingMessageRef.current.conversationId === activeConvId
      ) {
        socket.send(JSON.stringify({ message: pendingMessageRef.current.content }));
        pendingMessageRef.current = null;
      }
    };

    socket.onmessage = (event) => {
      if (streamSession !== streamSessionRef.current) return;
      const data = JSON.parse(event.data);
      if (data.type === 'conversation_created') {
        setActiveConvId(data.id);
        fetchConversations();
      } else if (data.type === 'chunk') {
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + data.content }];
          } else {
            return [...prev, { role: 'assistant', content: data.content }];
          }
        });
      } else if (data.type === 'done') {
        setLoading(false);
        fetchConversations();
      }
    };

    return () => socket.close();
  }, [activeConvId, provider, getHeaders, fetchConversations]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (!input.trim()) return;

    if (!activeConvId) {
      const token = localStorage.getItem('token');
      const socket = new WebSocket(`${WS_BASE}/chat`);
      ws.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ token, provider }));
        socket.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'conversation_created') {
            setActiveConvId(data.id);
            pendingMessageRef.current = { conversationId: data.id, content: input };
            setMessages([{ role: 'user', content: input }]);
            setInput('');
            setLoading(true);
            fetchConversations();
          }
        };
      };
    } else if (ws.current) {
      const userMsg: Message = { role: 'user', content: input };
      setMessages((prev) => [...prev, userMsg]);
      ws.current.send(JSON.stringify({ message: input }));
      setInput('');
      setLoading(true);
    }
  };

  const deleteConversation = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    // Optimistic UI update
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConvId === id) {
      setActiveConvId(null);
      setMessages([]);
      setLoading(false);
    }

    try {
      await fetch(`${API_BASE}/conversations/${id}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
    } catch {
        // Silent
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    router.push('/login');
  };

  return (
    <div className="flex h-screen bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 overflow-hidden">
      {/* Sidebar */}
      <div className={`${showSidebar ? 'w-80' : 'w-0'} border-r border-zinc-200 dark:border-zinc-800 flex flex-col transition-all duration-300 ease-in-out`}>
        <div className="p-4 flex items-center justify-between">
          <button 
            onClick={() => { setActiveConvId(null); setMessages([]); setLoading(false); }}
            className="flex items-center gap-2 flex-1 p-2 bg-zinc-100 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors font-medium"
          >
            <Plus size={18} /> New Chat
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <label className="px-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 block">Recent Chats</label>
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => { setActiveConvId(conv.id); setLoading(false); }}
              className={`group flex items-center gap-2 p-3 rounded-lg cursor-pointer transition-colors ${activeConvId === conv.id ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}
            >
              <MessageSquare size={16} className="text-zinc-400" />
              <span className="flex-1 truncate text-sm">{conv.title}</span>
              <button 
                onClick={(e) => deleteConversation(conv.id, e)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {user && (
          <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-lg">
              <button onClick={() => setProvider('gemini')} className={`flex-1 py-1 px-2 rounded-md text-xs transition-colors ${provider === 'gemini' ? 'bg-white dark:bg-zinc-700 shadow-sm' : ''}`}>Gemini</button>
              <button onClick={() => setProvider('openai')} className={`flex-1 py-1 px-2 rounded-md text-xs transition-colors ${provider === 'openai' ? 'bg-white dark:bg-zinc-700 shadow-sm' : ''}`}>OpenAI</button>
            </div>
            <div className="flex items-center gap-3">
              <img src={user.picture} alt={user.name} className="w-8 h-8 rounded-full" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user.name}</p>
                <p className="text-[10px] text-zinc-500 truncate">{user.email}</p>
              </div>
              <button onClick={handleLogout} className="p-2 text-zinc-400 hover:text-red-500 transition-colors">
                <LogOut size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative min-w-0 bg-white dark:bg-zinc-900">
        <header className="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center px-4 gap-4">
          <button 
            onClick={() => setShowSidebar(!showSidebar)}
            className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <BarChart size={20} className={showSidebar ? '' : 'rotate-180'} />
          </button>
          <h1 className="font-semibold truncate">
            {activeConvId ? conversations.find(c => c.id === activeConvId)?.title : 'New Chat'}
          </h1>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-4 max-w-md mx-auto">
              <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-2xl flex items-center justify-center mb-4">
                <Bot size={32} className="text-zinc-400" />
              </div>
              <h1 className="text-2xl font-bold">What can I help with today?</h1>
              <p className="text-zinc-500 text-sm">Select a model and start chatting. Your history is saved automatically.</p>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`flex gap-4 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-zinc-100 dark:bg-zinc-800' : 'bg-blue-600 text-white'}`}>
                  {msg.role === 'user' ? <UserIcon size={16} /> : <Bot size={16} />}
                </div>
                <div className={`p-4 rounded-2xl ${msg.role === 'user' ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-800 dark:text-zinc-200'}`}>
                  <div className="prose dark:prose-invert max-w-none text-sm leading-relaxed">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center">
                <Bot size={16} />
              </div>
              <div className="flex gap-1 items-center p-4">
                <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" />
              </div>
            </div>
          )}
          <div ref={scrollRef} />
        </div>

        <div className="p-4 md:p-8 pt-0 bg-white dark:bg-zinc-900">
          <div className="max-w-3xl mx-auto relative group">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="Message AI..."
              className="w-full bg-zinc-100 dark:bg-zinc-800 border-none rounded-2xl p-4 pr-12 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 resize-none min-h-[56px] max-h-48 text-sm outline-none transition-shadow"
              rows={1}
            />
            <button
              onClick={handleSendMessage}
              disabled={isSendDisabled}
              className="absolute right-3 bottom-3 p-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl disabled:opacity-20 transition-all hover:scale-105 active:scale-95 shadow-lg"
            >
              <Send size={18} />
            </button>
          </div>
          <p className="text-center text-[10px] text-zinc-400 mt-3">
            Gemini & OpenAI can make mistakes. Persistent chat enabled.
          </p>
        </div>
      </div>
    </div>
  );
}
