import React from 'react';
import { useApp } from '../context/AppContext';
import { Shield, Lock, Cpu, Server, ArrowRight, Play, CheckCircle2, Sparkles, Layers, HardDrive, Key, Database, Fingerprint } from 'lucide-react';
import { GlassCard } from '../components/GlassCard';

export const LandingPage: React.FC = () => {
  const { setCurrentRoute, setIsDemoOpen } = useApp();

  return (
    <div className="space-y-24 py-8 font-sans">
      {/* Hero Section */}
      <section className="text-center max-w-4xl mx-auto space-y-6 pt-12">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-semibold shadow-lg shadow-cyan-500/10 font-mono">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span>Enterprise Decentralized Storage Cloud • v2.4</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-white leading-tight">
          Decentralized Cloud Storage with <br />
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-cyan-300 to-indigo-400">
            Zero-Knowledge Sharding
          </span>
        </h1>

        <p className="text-sm md:text-base text-slate-400 max-w-2xl mx-auto leading-relaxed">
          SecureVault encrypts every byte client-side with AES-256-GCM, fragments ciphertext using Reed-Solomon (4+2) erasure coding, and distributes resilient shards across multi-cloud storage nodes with tamper-evident audit logs.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 pt-4">
          <button
            onClick={() => setCurrentRoute('register')}
            className="px-6 py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-bold text-sm shadow-xl shadow-blue-500/25 flex items-center gap-2 transition-all cursor-pointer"
          >
            <span>Launch Your Vault</span>
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsDemoOpen(true)}
            className="px-6 py-3.5 rounded-xl bg-slate-900/90 border border-slate-700/80 hover:border-slate-500 text-slate-200 font-semibold text-sm flex items-center gap-2 transition-all cursor-pointer shadow-sm"
          >
            <Play className="w-4 h-4 fill-current text-emerald-400" />
            <span>Interactive Demo</span>
          </button>
        </div>

        {/* Enterprise Spec Strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-8 max-w-3xl mx-auto">
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-center">
            <div className="text-[10px] font-mono text-slate-500 uppercase">Encryption</div>
            <div className="text-sm font-bold text-white font-mono mt-0.5">AES-256-GCM</div>
          </div>
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-center">
            <div className="text-[10px] font-mono text-slate-500 uppercase">Fault Tolerance</div>
            <div className="text-sm font-bold text-cyan-400 font-mono mt-0.5">RS (4+2) Quorum</div>
          </div>
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-center">
            <div className="text-[10px] font-mono text-slate-500 uppercase">Deduplication</div>
            <div className="text-sm font-bold text-emerald-400 font-mono mt-0.5">Content-Addressed</div>
          </div>
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-center">
            <div className="text-[10px] font-mono text-slate-500 uppercase">Audit Defense</div>
            <div className="text-sm font-bold text-purple-400 font-mono mt-0.5">SHA-256 Hash Chain</div>
          </div>
        </div>
      </section>

      {/* Feature Grid */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <GlassCard glow="blue" className="p-6 space-y-3.5">
          <div className="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400 shadow-inner">
            <Lock className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-white">Client-Side Zero-Knowledge</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Data Encryption Keys (DEKs) are generated and wrapped in browser memory via PBKDF2/Argon2. Decryption keys are never transmitted to backend servers or storage nodes.
          </p>
        </GlassCard>

        <GlassCard glow="cyan" className="p-6 space-y-3.5">
          <div className="w-11 h-11 rounded-xl bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center text-cyan-400 shadow-inner">
            <Cpu className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-white">Reed-Solomon (4+2) Cauchy Coding</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Ciphertext is fragmented into 4 data shards and 2 Cauchy parity shards. Full payload reconstruction succeeds even if any 2 of 6 storage nodes experience complete outage.
          </p>
        </GlassCard>

        <GlassCard glow="purple" className="p-6 space-y-3.5">
          <div className="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/25 flex items-center justify-center text-purple-400 shadow-inner">
            <Server className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-white">Multi-Cloud Storage Mesh</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Shards are dispersed across independent storage emulators mapped to AWS S3, Google Cloud Storage, and Azure Blob storage nodes with live ML telemetry scoring.
          </p>
        </GlassCard>
      </section>
    </div>
  );
};
