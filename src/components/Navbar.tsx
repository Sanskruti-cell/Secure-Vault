import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Shield, Sparkles, LogOut, Command, Play, Search, User as UserIcon, Lock, Unlock, Key, Server, CheckCircle2 } from 'lucide-react';

export const Navbar: React.FC = () => {
  const { 
    currentRoute, 
    setCurrentRoute, 
    user, 
    logout, 
    setIsAiOpen, 
    setIsDemoOpen, 
    files, 
    nodes,
    setSelectedFile,
    isVaultLocked,
    lockVault,
    setIsLockModalOpen,
    isMasterPasswordSetupRequired
  } = useApp();
  const [searchTerm, setSearchTerm] = useState('');

  const isAuthView = !['landing', 'login', 'register'].includes(currentRoute);

  const totalNodesCount = nodes.length || 6;
  const healthyNodesCount = nodes.length > 0
    ? nodes.filter((n: any) => n.status === 'online' && !n.isSimulatedFailure && (n.mlStatus === 'Healthy' || !n.mlStatus)).length
    : 6;
  const isAllHealthy = healthyNodesCount >= totalNodesCount;

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;
    const match = files.find(f => f.name.toLowerCase().includes(searchTerm.toLowerCase()) || f.hash?.includes(searchTerm));
    if (match) {
      setSelectedFile(match);
      setCurrentRoute('file-details');
    } else {
      setCurrentRoute('vault');
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 h-16 bg-[#060a14]/90 backdrop-blur-xl border-b border-slate-800/80 z-40 px-4 md:px-8 flex items-center justify-between shadow-[0_4px_24px_rgba(0,0,0,0.4)]">
      {/* Brand Logo */}
      <div className="flex items-center gap-6">
        <div
          onClick={() => setCurrentRoute(user ? 'dashboard' : 'landing')}
          className="flex items-center gap-3 cursor-pointer group"
        >
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-cyan-500 to-indigo-600 p-[1.5px] shadow-lg shadow-blue-500/20 group-hover:shadow-cyan-500/35 transition-all duration-300">
            <div className="w-full h-full bg-[#080d1a] rounded-[9.5px] flex items-center justify-center">
              <Shield className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform duration-300" />
            </div>
          </div>
          <div>
            <span className="font-bold text-lg text-white tracking-tight flex items-center gap-1.5">
              SecureVault
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-cyan-400 border border-cyan-500/25">
                v2.4 Enterprise
              </span>
            </span>
            <span className="block text-[10px] text-slate-400 -mt-0.5 font-mono">Zero-Knowledge Storage Cloud</span>
          </div>
        </div>

        {/* Live Cluster Status Pill (when authenticated) */}
        {user && (
          <div 
            onClick={() => setCurrentRoute('nodes')}
            className="hidden lg:flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900/80 border border-slate-800/90 text-xs font-mono cursor-pointer hover:border-slate-700 transition-colors"
            title="Cluster Status"
          >
            <span className={`w-2 h-2 rounded-full ${isAllHealthy ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400 animate-ping'}`} />
            <span className="text-slate-400 text-[11px]">Cluster:</span>
            <span className={`font-semibold ${isAllHealthy ? 'text-emerald-400' : 'text-amber-400'}`}>
              {healthyNodesCount}/{totalNodesCount} Nodes Online
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-cyan-400 text-[11px]">RS (4+2)</span>
          </div>
        )}
      </div>

      {/* Center Layout: Global Search in Authenticated Mode vs Landing Navigation in Public Mode */}
      {isAuthView || user ? (
        <form onSubmit={handleSearchSubmit} className="hidden md:flex items-center relative max-w-sm w-full mx-4">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search files, SHA-256 hashes, nodes..."
            className="w-full bg-slate-950/80 border border-slate-800/90 rounded-xl pl-9 pr-12 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-500/60 focus:bg-slate-900/90 focus:outline-none transition-all shadow-inner"
          />
          <kbd className="absolute right-2.5 top-2 text-[10px] font-mono text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
            Enter
          </kbd>
        </form>
      ) : (
        <nav className="hidden md:flex items-center gap-1 bg-slate-900/60 p-1 rounded-xl border border-slate-800/60">
          {[
            { id: 'landing', label: 'Home' },
            { id: 'login', label: 'Sign In' },
            { id: 'register', label: 'Get Started' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setCurrentRoute(item.id)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentRoute === item.id
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}

      {/* Right Actions */}
      <div className="flex items-center gap-2 md:gap-3">
        <button
          onClick={() => setIsDemoOpen(true)}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-all shadow-sm"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          Interactive Demo
        </button>

        <button
          onClick={() => setIsAiOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-blue-600/15 via-cyan-500/15 to-purple-600/15 text-cyan-300 border border-cyan-500/30 hover:border-cyan-400 hover:shadow-lg hover:shadow-cyan-500/20 transition-all"
        >
          <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
          <span className="hidden lg:inline">AI Command</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono bg-slate-900/90 px-1.5 py-0.5 rounded text-slate-400 border border-slate-700/80">
            <Command className="w-2.5 h-2.5" />K
          </kbd>
        </button>

        {user ? (
          <div className="flex items-center gap-2 pl-2 border-l border-slate-800/90">
            {/* Vault Master Key Lock/Unlock Status Button */}
            {isMasterPasswordSetupRequired ? (
              <button
                onClick={() => setIsLockModalOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-all animate-pulse"
                title="Initialize Master Password"
              >
                <Key className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Setup Key</span>
              </button>
            ) : isVaultLocked ? (
              <button
                onClick={() => setIsLockModalOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/40 hover:bg-purple-500/25 transition-all shadow-lg shadow-purple-500/10"
                title="Vault Locked - Click to Unlock"
              >
                <Lock className="w-3.5 h-3.5 text-purple-400" />
                <span className="hidden sm:inline">Locked</span>
              </button>
            ) : (
              <button
                onClick={lockVault}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 transition-all group"
                title="Vault Unlocked - Click to Lock"
              >
                <Unlock className="w-3.5 h-3.5 group-hover:hidden" />
                <Lock className="w-3.5 h-3.5 hidden group-hover:inline text-red-400" />
                <span className="hidden sm:inline group-hover:hidden">Unlocked</span>
                <span className="hidden sm:group-hover:inline text-red-400">Lock Now</span>
              </button>
            )}

            <button
              onClick={() => setCurrentRoute('settings')}
              className="flex items-center gap-2 text-xs font-medium text-slate-200 hover:text-white group"
            >
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600/40 to-cyan-500/30 border border-blue-500/40 flex items-center justify-center text-cyan-300 font-bold shadow-inner group-hover:border-cyan-400 transition-colors">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <span className="hidden xl:inline">{user.name}</span>
            </button>
            <button
              onClick={logout}
              title="Logout"
              className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentRoute('login')}
              className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-slate-300 hover:text-white transition-colors"
            >
              Sign In
            </button>
            <button
              onClick={() => setCurrentRoute('register')}
              className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white shadow-lg shadow-blue-600/20 transition-all"
            >
              Get Started
            </button>
          </div>
        )}
      </div>
    </header>
  );
};