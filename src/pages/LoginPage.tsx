import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Shield, Lock, Mail, ArrowRight, Loader2 } from 'lucide-react';
import { GlassCard } from '../components/GlassCard';

export const LoginPage: React.FC = () => {
  const { login, setCurrentRoute } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || loading) return;
    setLoading(true);
    await login(email.trim(), password);
    setLoading(false);
  };

  return (
    <div className="min-h-[75vh] flex items-center justify-center py-8 font-sans">
      <GlassCard glow="blue" className="p-8 max-w-md w-full space-y-6 shadow-2xl">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600/30 to-cyan-500/20 border border-blue-500/30 flex items-center justify-center text-cyan-400 mx-auto shadow-inner">
            <Shield className="w-7 h-7" />
          </div>
          <h2 className="text-xl font-extrabold text-white tracking-tight">Access SecureVault</h2>
          <p className="text-xs text-slate-400">Authenticate Zero-Knowledge Session & Decrypt Master Key</p>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-500/10 text-cyan-400 border border-cyan-500/20 text-[10px] font-mono">
            Client-Side PBKDF2 • 100k Iterations
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Vault Account Email</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alex@securevault.io"
                className="w-full bg-slate-950/90 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-500/70 focus:outline-none transition-all"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Vault Master Passphrase</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-slate-950/90 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-500/70 focus:outline-none transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-bold text-xs shadow-lg shadow-blue-500/25 flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>Open Vault</span>}
            {!loading && <ArrowRight className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => {
              setEmail('alex@securevault.io');
              setPassword('password123');
            }}
            className="w-full py-2.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 text-cyan-300 font-semibold text-xs flex items-center justify-center gap-2 transition-all hover:border-cyan-500/40 cursor-pointer"
          >
            <span>⚡ Auto-fill Demo Account (alex@securevault.io)</span>
          </button>
        </form>

        <div className="text-center text-xs text-slate-400 pt-2 border-t border-slate-800">
          Don't have a vault yet?{' '}
          <button
            onClick={() => setCurrentRoute('register')}
            className="text-cyan-400 font-semibold hover:underline cursor-pointer"
          >
            Create Vault
          </button>
        </div>
      </GlassCard>
    </div>
  );
};