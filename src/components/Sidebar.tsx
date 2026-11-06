import React from 'react';
import { useApp } from '../context/AppContext';
import {
  LayoutDashboard,
  FolderLock,
  UploadCloud,
  ShieldCheck,
  Server,
  Settings,
  Share2,
  Lock,
  Radio,
  Layers,
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { currentRoute, setCurrentRoute, nodes, isVaultLocked } = useApp();

  const totalNodesCount = nodes.length || 6;
  const healthyNodesCount = nodes.length > 0
    ? nodes.filter((n: any) => n.status === 'online' && !n.isSimulatedFailure && (n.mlStatus === 'Healthy' || !n.mlStatus)).length
    : 6;
  const isAllHealthy = healthyNodesCount >= totalNodesCount;
  const healthPct = Math.round((healthyNodesCount / totalNodesCount) * 100);

  const navSections = [
    {
      label: 'Core Storage & Vault',
      items: [
        { id: 'dashboard', label: 'Command Center', icon: LayoutDashboard },
        { id: 'vault', label: 'My Vault', icon: FolderLock },
        { id: 'upload', label: 'Ingest & Encrypt', icon: UploadCloud },
        { id: 'shared', label: 'Share Envelopes', icon: Share2 },
      ]
    },
    {
      label: 'Security & Cluster',
      items: [
        { id: 'security', label: 'Security & Audit', icon: ShieldCheck },
        { id: 'nodes', label: 'Storage Nodes', icon: Server },
        { id: 'settings', label: 'Vault Configuration', icon: Settings },
      ]
    }
  ];

  return (
    <aside className="w-64 fixed left-0 top-16 bottom-0 bg-[#060a14]/90 backdrop-blur-xl border-r border-slate-800/80 p-4 hidden md:flex flex-col justify-between z-30 shadow-[4px_0_24px_rgba(0,0,0,0.35)]">
      <div className="space-y-6">
        {navSections.map((sec, secIdx) => (
          <div key={secIdx} className="space-y-1">
            <div className="px-3 py-1 text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider">
              {sec.label}
            </div>

            {sec.items.map((item) => {
              const Icon = item.icon;
              const isActive = currentRoute === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentRoute(item.id)}
                  className={`relative w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all group ${
                    isActive
                      ? 'bg-gradient-to-r from-blue-600/20 to-cyan-500/10 text-white border border-cyan-500/30 shadow-md shadow-cyan-950/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                  }`}
                >
                  {/* Left Active Glow Indicator */}
                  {isActive && (
                    <div className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-gradient-to-b from-blue-500 to-cyan-400 rounded-r shadow-[0_0_8px_rgba(6,182,212,0.8)]" />
                  )}
                  <Icon className={`w-4 h-4 transition-colors ${isActive ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-300'}`} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Dynamic Node Cluster Health Widget */}
      <div className="bg-slate-950/80 border border-slate-800/90 rounded-2xl p-4 space-y-3 shadow-lg">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-semibold text-slate-200">Storage Mesh</span>
          </div>
          <span className={`text-[10px] font-mono font-semibold flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${
            isAllHealthy 
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
              : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              isAllHealthy ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400 animate-ping'
            }`} />
            {isAllHealthy ? 'Active' : 'Degraded'}
          </span>
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-slate-400 font-mono">
            <span>Cluster Quorum</span>
            <span className="text-white font-bold">{healthPct}%</span>
          </div>
          <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden border border-slate-800">
            <div
              className={`h-full transition-all duration-500 ${
                isAllHealthy
                  ? 'bg-gradient-to-r from-blue-500 via-cyan-400 to-emerald-400'
                  : 'bg-gradient-to-r from-amber-500 to-red-400'
              }`}
              style={{ width: `${Math.max(10, healthPct)}%` }}
            />
          </div>
        </div>

        <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono pt-1 border-t border-slate-900">
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3 text-cyan-400" /> RS 4+2 Scheme
          </span>
          <span className="text-slate-400">{healthyNodesCount}/{totalNodesCount} Nodes</span>
        </div>
      </div>
    </aside>
  );
};