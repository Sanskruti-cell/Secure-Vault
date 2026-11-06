import React from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import { Clock, Shield, UploadCloud, Download, Trash2, Key } from 'lucide-react';

export const ActivityPage: React.FC = () => {
  const { activities } = useApp();

  return (
    <div className="space-y-6 page-enter">
      <div>
        <h1 className="text-2xl font-bold text-white">Security & Audit Activity Logs</h1>
        <p className="text-xs text-slate-400">Immutable Audit Trail of Vault Operations</p>
      </div>

      {activities.length === 0 ? (
        <GlassCard className="p-12 text-center space-y-3">
          <Clock className="w-8 h-8 text-slate-600 mx-auto" />
          <div className="text-sm font-semibold text-slate-300">No activity recorded yet</div>
        </GlassCard>
      ) : (
        <GlassCard className="p-6 space-y-4">
          <div className="space-y-3">
            {activities.map((item) => (
              <div
                key={item.id}
                className="p-3.5 bg-slate-900/60 rounded-xl border border-slate-800 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                    <Clock className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-200">{item.description}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{item.timestamp}</div>
                  </div>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {item.status || 'success'}
                </span>
              </div>
            ))}
          </div>
        </GlassCard>
      )}
    </div>
  );
};