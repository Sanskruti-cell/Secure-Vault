import React from 'react';
import { useApp } from '../context/AppContext';
import { X, Play, ShieldCheck, Lock, Share2, Server } from 'lucide-react';

export const InteractiveDemoModal: React.FC = () => {
  const { isDemoOpen, setIsDemoOpen, setCurrentRoute } = useApp();

  if (!isDemoOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d1424] border border-emerald-500/40 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl shadow-emerald-500/20">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
          <div className="flex items-center gap-2">
            <Play className="w-5 h-5 text-emerald-400 fill-current" />
            <span className="font-bold text-slate-100 text-sm">Interactive System Tour</span>
          </div>
          <button
            onClick={() => setIsDemoOpen(false)}
            className="p-1 rounded-lg text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-xs text-slate-300 leading-relaxed">
            Experience SecureVault’s end-to-end decentralized architecture in action. Explore how zero-knowledge AES-256-GCM encryption and distributed node allocation protect user data.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {[
              { title: '1. File Encryption & Sharding', desc: 'AES-256-GCM & 4-node split', route: 'upload', icon: Lock },
              { title: '2. Storage Node Network', desc: 'Real-time node telemetry', route: 'nodes', icon: Server },
              { title: '3. Zero-Knowledge Audit', desc: 'SHA-256 integrity check', route: 'security', icon: ShieldCheck },
              { title: '4. Encrypted Sharing', desc: 'Password-protected links', route: 'shared', icon: Share2 },
            ].map((step) => {
              const Icon = step.icon;
              return (
                <button
                  key={step.title}
                  onClick={() => {
                    setCurrentRoute(step.route);
                    setIsDemoOpen(false);
                  }}
                  className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl hover:border-emerald-500/50 text-left transition-all group"
                >
                  <Icon className="w-5 h-5 text-emerald-400 mb-2 group-hover:scale-110 transition-transform" />
                  <div className="text-xs font-semibold text-slate-200">{step.title}</div>
                  <div className="text-[10px] text-slate-400">{step.desc}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};