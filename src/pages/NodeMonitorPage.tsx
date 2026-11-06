import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import { Server, Activity, Globe, HardDrive, Cpu, Filter, ArrowUpDown, Sparkles, AlertTriangle, RefreshCw, CheckCircle2, ShieldAlert, Radio, Database } from 'lucide-react';
import { api } from '../services/api';

export const NodeMonitorPage: React.FC = () => {
  const { nodes, loadBackendData, showToast, updateNodeOptimistic } = useApp();
  const [filter, setFilter] = useState<'all' | 'healthy' | 'degraded' | 'offline'>('all');
  const [sortBy, setSortBy] = useState<'reliability' | 'latency' | 'uptime'>('reliability');
  const [confirmNode, setConfirmNode] = useState<any | null>(null);

  const filteredNodes = nodes.filter((n: any) => {
    const isOffline = n.status === 'offline' || n.isSimulatedFailure;
    if (filter === 'healthy') return n.status !== 'unhealthy' && n.status !== 'degraded' && !isOffline;
    if (filter === 'degraded') return n.status === 'unhealthy' || n.status === 'degraded';
    if (filter === 'offline') return isOffline;
    return true;
  });

  const sortedNodes = [...filteredNodes].sort((a: any, b: any) => {
    if (sortBy === 'reliability') {
      return (b.mlReliabilityScore || b.uptime || 0) - (a.mlReliabilityScore || a.uptime || 0);
    }
    if (sortBy === 'latency') {
      return (a.latency || 0) - (b.latency || 0);
    }
    return (b.uptime || 0) - (a.uptime || 0);
  });

  const handleToggleFailure = async (node: any) => {
    if (!node) return;
    const targetId = node.id || node.nodeId;
    const willBeOffline = !(node.status === 'offline' || node.isSimulatedFailure);

    // 1. Close modal instantly — zero perceived latency!
    setConfirmNode(null);

    // 2. Optimistically update node card state immediately (0ms lag)
    updateNodeOptimistic(targetId, {
      status: willBeOffline ? 'offline' : 'online',
      isSimulatedFailure: willBeOffline,
      mlReliabilityScore: willBeOffline ? 0 : 98.5
    });
    showToast(
      willBeOffline ? `Node ${node.name} simulated failure activated (OFFLINE)` : `Node ${node.name} restored to ONLINE`,
      willBeOffline ? 'warning' : 'success'
    );

    // 3. Fire API in background — backend now responds instantly (no MongoDB block)
    api.toggleNodeStatus(targetId)
      .then(res => {
        if (res && res.node) updateNodeOptimistic(targetId, res.node);
        // Delay data refresh so it doesn't race against the optimistic update
        setTimeout(() => loadBackendData(), 1500);
      })
      .catch(err => {
        showToast(err.message || 'Failed to update node status', 'danger');
        setTimeout(() => loadBackendData(), 500);
      });
  };

  const handleRestoreNode = async (node: any) => {
    if (!node) return;
    const targetId = node.id || node.nodeId;

    // 1. Optimistically update node immediately (0ms lag)
    updateNodeOptimistic(targetId, {
      status: 'online',
      isSimulatedFailure: false,
      mlReliabilityScore: 98.5,
      mlStatus: 'Healthy'
    });
    showToast(`Node ${node.name} restored to ONLINE status`, 'success');

    // 2. Fire API in background — backend responds instantly (no MongoDB block)
    api.restoreNode(targetId)
      .then(res => {
        if (res && res.node) updateNodeOptimistic(targetId, res.node);
        setTimeout(() => loadBackendData(), 1500);
      })
      .catch(err => {
        showToast(err.message || 'Failed to restore node', 'danger');
        setTimeout(() => loadBackendData(), 500);
      });
  };

  const handleRestoreAllNodes = async () => {
    // Optimistically restore all nodes immediately
    nodes.forEach((n: any) => {
      updateNodeOptimistic(n.id || n.nodeId, {
        status: 'online',
        isSimulatedFailure: false,
        mlReliabilityScore: 98.5,
        mlStatus: 'Healthy'
      });
    });
    showToast('All cluster nodes restored to 100% Online health', 'success');

    // Fire all restores in background
    const targetNodes = nodes.filter((n: any) => n.status !== 'online' || n.isSimulatedFailure || n.mlStatus === 'Degraded/Unhealthy');
    Promise.all(targetNodes.map((n: any) => api.restoreNode(n.id || n.nodeId).catch(() => {})))
      .then(() => setTimeout(() => loadBackendData(), 1500))
      .catch(() => {});
  };

  const totalNodesCount = nodes.length || 6;
  const activeNodesCount = nodes.length > 0
    ? nodes.filter((n: any) => n.status === 'online' && !n.isSimulatedFailure && (n.mlStatus === 'Healthy' || !n.mlStatus)).length
    : 6;
  const offlineNodesCount = totalNodesCount - activeNodesCount;

  return (
    <div className="space-y-6 page-enter font-sans">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-800/80">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
              Storage Cluster Telemetry
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-500/10 text-cyan-400 border border-cyan-500/25 text-[11px] font-mono font-medium">
              6 Physical Node Emulators
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Decentralized Shard Mesh • Reed-Solomon (4+2) Quorum • AI/ML Predictive Node Health
          </p>
        </div>

        <button
          onClick={handleRestoreAllNodes}
          className="px-4 py-2 rounded-xl bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/30 transition-all text-xs font-semibold flex items-center gap-2 self-start sm:self-auto shadow-sm cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Restore All Nodes to 100%</span>
        </button>
      </div>

      {/* Cluster Overview Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <GlassCard glow="none" className="p-4 space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-400">Total Nodes</div>
          <div className="text-xl font-bold font-mono text-white">{totalNodesCount} Nodes</div>
          <div className="text-[10px] text-slate-500">Global Infrastructure</div>
        </GlassCard>

        <GlassCard glow="none" className="p-4 space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-400">Online & Active</div>
          <div className="text-xl font-bold font-mono text-emerald-400">{activeNodesCount} Nodes</div>
          <div className="text-[10px] text-emerald-500/80 font-mono">Quorum Ready</div>
        </GlassCard>

        <GlassCard glow="none" className="p-4 space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-400">Simulated Outages</div>
          <div className="text-xl font-bold font-mono text-amber-400">{offlineNodesCount} Nodes</div>
          <div className="text-[10px] text-slate-500 font-mono">Max 2 Tolerated (RS 4+2)</div>
        </GlassCard>

        <GlassCard glow="none" className="p-4 space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-400">Fault Tolerance</div>
          <div className="text-xl font-bold font-mono text-cyan-400">Reed-Solomon 4+2</div>
          <div className="text-[10px] text-cyan-500/80 font-mono">4 of 6 Minimum Quorum</div>
        </GlassCard>
      </div>

      {/* ML System Explanation Banner */}
      <GlassCard glow="cyan" className="p-4 flex items-start gap-3.5 bg-cyan-950/20 border-cyan-500/30">
        <Sparkles className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5 animate-pulse" />
        <div className="text-xs text-cyan-200 leading-relaxed">
          <strong className="text-cyan-300 font-semibold">Decentralized Storage Node Architecture: </strong>
          The 6 storage nodes represent simulated local micro-service nodes mapped to AWS S3, Google Cloud Storage, and Azure Blob storage layouts. Each node stores encrypted shards with SVEC magic headers. You can simulate single-node failures to observe Reed-Solomon (4+2) automated recovery in real time.
        </div>
      </GlassCard>

      {/* Filters & Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-950/70 p-3 rounded-2xl border border-slate-800/80">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Filter className="w-4 h-4 text-slate-400" />
          <span className="text-slate-400 font-medium">Filter Nodes:</span>
          {[
            { id: 'all', label: 'All Nodes' },
            { id: 'healthy', label: 'Healthy Only' },
            { id: 'degraded', label: 'Degraded' },
            { id: 'offline', label: 'Offline / Simulated Outage' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id as any)}
              className={`px-3 py-1 rounded-xl text-xs transition-all cursor-pointer ${
                filter === f.id
                  ? 'bg-blue-600 text-white font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <ArrowUpDown className="w-4 h-4 text-slate-400" />
          <span className="text-slate-400 font-medium">Sort By:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none cursor-pointer"
          >
            <option value="reliability">ML Reliability Score</option>
            <option value="latency">Lowest Ping Latency</option>
            <option value="uptime">Highest Uptime</option>
          </select>
        </div>
      </div>

      {/* Grid of Nodes */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {sortedNodes.map((node: any) => {
          const isOffline = node.status === 'offline' || node.isSimulatedFailure;
          const isHealthy = !isOffline && node.status !== 'unhealthy' && node.status !== 'degraded';
          const mlScore = isOffline ? 0 : (node.mlReliabilityScore || (isHealthy ? 98.5 : 68.2));
          const userShards = node.userShardsCount || 0;
          const userStorageText = node.userStorageMB ? `${node.userStorageMB} MB` : '0.00 MB';

          return (
            <GlassCard
              key={node.id || node.nodeId}
              glow={isOffline ? 'none' : isHealthy ? 'blue' : 'none'}
              className={`p-6 space-y-4 ${
                isOffline ? 'bg-red-950/20 border-red-500/40 shadow-[0_0_24px_rgba(239,68,68,0.15)]' : ''
              }`}
            >
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow-inner ${
                    isOffline 
                      ? 'bg-red-500/10 text-red-400 border-red-500/30' 
                      : isHealthy 
                      ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' 
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  }`}>
                    <Server className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                      {node.name}
                      <span className={`w-2 h-2 rounded-full ${isOffline ? 'bg-red-400 animate-ping' : 'bg-emerald-400'}`} />
                    </h3>
                    <div className="text-[10px] text-slate-500 font-mono">{node.region || 'Region Local'}</div>
                    {/* Cloud Provider Badge */}
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      <span className={`text-[9px] font-bold font-mono px-2 py-0.5 rounded border ${
                        (node.provider === 'aws-s3' || node.name.includes('AWS'))
                          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                          : (node.provider === 'gcp-gcs' || node.name.includes('GCP'))
                          ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                          : (node.provider === 'azure-blob' || node.name.includes('AZURE'))
                          ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}>
                        {node.provider ? node.provider.toUpperCase() : (node.name.includes('AWS') ? 'AWS S3' : node.name.includes('GCP') ? 'GCP GCS' : 'AZURE BLOB')}
                      </span>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                        Local Shard Emulator
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                      isOffline
                        ? 'bg-red-500/20 text-red-400 border-red-500/40 font-bold'
                        : isHealthy
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-semibold'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}
                  >
                    {isOffline ? 'OFFLINE' : isHealthy ? 'Healthy' : 'Degraded'}
                  </span>
                  {isOffline && (
                    <span className="text-[9px] font-mono text-red-300/80 uppercase tracking-wider font-semibold">
                      Outage Active
                    </span>
                  )}
                  {node.emulatorBucket && (
                    <span className="text-[8px] font-mono text-slate-500 truncate max-w-[110px]" title={node.emulatorBucket}>
                      📁 {node.emulatorBucket}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800/80">
                  <div className="text-[10px] text-slate-500 font-mono">Ping Latency</div>
                  <div className={`font-mono font-bold text-sm mt-0.5 ${isOffline ? 'text-slate-600' : 'text-slate-200'}`}>
                    {isOffline ? '—' : `${node.latency} ms`}
                  </div>
                </div>
                <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800/80">
                  <div className="text-[10px] text-slate-500 font-mono">ML Reliability</div>
                  <div className={`font-mono font-bold text-sm mt-0.5 ${isOffline ? 'text-red-400' : 'text-cyan-400'}`}>
                    {isOffline ? '0.0%' : `${mlScore}%`}
                  </div>
                </div>
              </div>

              {/* User Shard Allocation Telemetry */}
              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-slate-400 font-semibold">User Shards Stored:</span>
                  <span className={`font-mono px-2 py-0.5 rounded font-semibold ${userShards > 0 ? (isOffline ? 'bg-red-500/10 text-red-300 border border-red-500/30' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20') : 'bg-slate-800 text-slate-400'}`}>
                    {userShards} {userShards === 1 ? 'Shard' : 'Shards'}
                  </span>
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>Vault Allocation Usage:</span>
                  <span className="text-slate-300 font-semibold">{userStorageText}</span>
                </div>
              </div>

              {/* Node Action Buttons */}
              <div className="pt-2 border-t border-slate-800/60">
                {isOffline ? (
                  <button
                    type="button"
                    onClick={() => handleRestoreNode(node)}
                    className="w-full py-2.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white border border-emerald-500/30 transition-all text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] cursor-pointer shadow-sm"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Restore Node to Online</span>
                  </button>
                ) : !isHealthy ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleRestoreNode(node)}
                      className="flex-1 py-2.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white border border-emerald-500/30 transition-all text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Optimize to 100%</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmNode(node)}
                      className="px-3.5 py-2.5 rounded-xl bg-slate-900 hover:bg-red-950/40 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-500/30 transition-all text-xs font-medium flex items-center justify-center active:scale-[0.98] cursor-pointer"
                      title="Simulate Offline Outage"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500/80" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmNode(node)}
                    className="w-full py-2.5 rounded-xl bg-slate-900/90 hover:bg-red-950/30 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-500/30 transition-all text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] cursor-pointer"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500/80" />
                    <span>Simulate Outage</span>
                  </button>
                )}
              </div>
            </GlassCard>
          );
        })}
      </div>

      {/* Confirmation Modal for Node Failure Simulation */}
      {confirmNode && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <GlassCard glow="none" className="max-w-md w-full p-6 space-y-4 border-amber-500/30 text-left shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Simulate Node Failure?</h3>
                <p className="text-xs text-slate-400 font-mono">Target: <span className="text-white font-bold">{confirmNode.name} ({confirmNode.nodeId})</span></p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed bg-slate-950 p-3.5 rounded-xl border border-slate-800">
              Simulate failure of <strong>{confirmNode.name}</strong>? This triggers an offline node simulation to test Reed-Solomon (4+2) quorum recovery. File shards on disk remain safe.
            </p>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmNode(null)}
                className="flex-1 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-semibold text-xs transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleToggleFailure(confirmNode)}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg shadow-red-500/25 transition-all flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer"
              >
                <span>Confirm Offline Outage</span>
              </button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
};
