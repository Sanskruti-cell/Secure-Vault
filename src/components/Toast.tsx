import React from 'react';
import { useApp } from '../context/AppContext';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

export const Toast: React.FC = () => {
  const { toasts, removeToast } = useApp();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm w-full">
      {toasts.map((toast) => {
        const iconMap = {
          success: <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />,
          warning: <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />,
          danger: <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />,
          info: <Info className="w-4 h-4 text-cyan-400 shrink-0" />,
        };

        const borderMap = {
          success: 'border-emerald-500/40 bg-emerald-950/40',
          warning: 'border-amber-500/40 bg-amber-950/40',
          danger: 'border-red-500/40 bg-red-950/40',
          info: 'border-cyan-500/40 bg-cyan-950/40',
        };

        return (
          <div
            key={toast.id}
            className={`p-3.5 rounded-xl border backdrop-blur-xl shadow-xl flex items-center justify-between gap-3 text-xs text-slate-100 animate-slide-up ${borderMap[toast.type]}`}
          >
            <div className="flex items-center gap-2.5">
              {iconMap[toast.type]}
              <span>{toast.message}</span>
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="text-slate-400 hover:text-white p-0.5 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
