import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import { VaultFile } from '../types';
import {
  FileText,
  Download,
  Trash2,
  Search,
  Lock,
  Layers,
  Database,
  Sparkles,
  RefreshCw,
  HardDrive,
  ShieldCheck,
  Share2,
  Loader2,
  LayoutGrid,
  List,
  Copy,
  Check,
  FileCode,
  FileSpreadsheet,
  FileArchive,
  Image as ImageIcon,
  Key,
  ShieldAlert,
  ArrowUpRight,
} from 'lucide-react';

export const VaultPage: React.FC = () => {
  const { 
    files, 
    deleteFile, 
    setCurrentRoute, 
    setSelectedFile, 
    isVaultLocked, 
    setIsLockModalOpen, 
    setIsShareOpen, 
    setShareTargetFile,
    dedupStats,
    isLoadingDedup,
    loadDedupStats,
    isLoading,
    showToast
  } = useApp();

  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'pdf' | 'images' | 'docs'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!dedupStats || (files.length > 0 && (dedupStats.totalLogicalBytes === 0 || dedupStats.totalChunks === 0))) {
      loadDedupStats(true);
    }
  }, [files.length]);

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  const renderStatValue = (val: string, colorClass = 'text-white') => {
    if (!dedupStats && (isLoadingDedup || isLoading)) {
      return <div className="h-6 w-20 bg-slate-800 animate-pulse rounded my-1" />;
    }
    return <div className={`text-base sm:text-lg font-bold font-mono ${colorClass}`}>{val}</div>;
  };

  const filteredFiles = files.filter((f) => {
    const matchesSearch = f.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (f.hash && f.hash.toLowerCase().includes(searchTerm.toLowerCase()));
    
    if (!matchesSearch) return false;

    if (selectedFilter === 'pdf') {
      return f.name.toLowerCase().endsWith('.pdf');
    }
    if (selectedFilter === 'images') {
      const ext = f.name.toLowerCase();
      return ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.webp') || ext.endsWith('.svg');
    }
    if (selectedFilter === 'docs') {
      const ext = f.name.toLowerCase();
      return ext.endsWith('.doc') || ext.endsWith('.docx') || ext.endsWith('.txt') || ext.endsWith('.md') || ext.endsWith('.csv') || ext.endsWith('.json');
    }
    return true;
  });

  const handleCopyHash = (hash: string, id: string) => {
    if (!hash) return;
    navigator.clipboard.writeText(hash);
    setCopiedId(id);
    showToast('SHA-256 fingerprint copied to clipboard', 'info');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleTriggerDownload = (file: VaultFile) => {
    if (isVaultLocked) {
      setIsLockModalOpen(true);
      return;
    }
    setSelectedFile(file);
    setCurrentRoute('download');
  };

  const handleTriggerViewShards = (file: VaultFile) => {
    setSelectedFile(file);
    setCurrentRoute('shards');
  };

  const handleDeleteWithRefresh = async (fileId: string) => {
    await deleteFile(fileId);
    // deleteFile now handles optimistic UI removal and background dedup refresh
  };

  const handleTriggerShare = (file: VaultFile) => {
    setShareTargetFile(file);
    setIsShareOpen(true);
  };

  const getFileIcon = (fileName: string) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.pdf')) {
      return <FileText className="w-5 h-5 text-rose-400" />;
    }
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')) {
      return <ImageIcon className="w-5 h-5 text-cyan-400" />;
    }
    if (name.endsWith('.zip') || name.endsWith('.tar') || name.endsWith('.gz')) {
      return <FileArchive className="w-5 h-5 text-amber-400" />;
    }
    if (name.endsWith('.csv') || name.endsWith('.xlsx')) {
      return <FileSpreadsheet className="w-5 h-5 text-emerald-400" />;
    }
    if (name.endsWith('.json') || name.endsWith('.js') || name.endsWith('.ts')) {
      return <FileCode className="w-5 h-5 text-purple-400" />;
    }
    return <FileText className="w-5 h-5 text-blue-400" />;
  };

  return (
    <div className="space-y-6 page-enter font-sans">
      {/* Page Title & Top Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-slate-800/80">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
              Encrypted Vault Catalog
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/25 text-[11px] font-mono font-medium">
              {files.length} Files Dispersed
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Zero-Knowledge Ingestion • Client-Side AES-256-GCM • Reed-Solomon (4+2) Fault Tolerance
          </p>
        </div>

        <div className="flex items-center gap-3">
          {isVaultLocked && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-500/15 border border-purple-500/35 text-xs text-purple-300 shadow-md">
              <Lock className="w-3.5 h-3.5 text-purple-400" />
              <span>Vault Locked</span>
              <button
                onClick={() => setIsLockModalOpen(true)}
                className="ml-1 font-bold underline hover:text-white cursor-pointer"
              >
                Unlock
              </button>
            </div>
          )}

          <button
            onClick={() => setCurrentRoute('upload')}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-semibold text-xs shadow-lg shadow-blue-500/25 flex items-center gap-2 transition-all cursor-pointer"
          >
            <span>Upload New File</span>
          </button>
        </div>
      </div>

      {/* Deduplication & Storage Optimization Metrics Card */}
      <GlassCard glow="cyan" className="p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold text-white tracking-wide">
              Content-Addressed Deduplication & Real Storage Optimization
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
              Live Shard Telemetry
            </span>
          </div>
          <button
            onClick={() => loadDedupStats(true)}
            disabled={isLoadingDedup}
            className="flex items-center gap-1.5 text-xs font-mono text-slate-400 hover:text-cyan-400 transition-colors self-start sm:self-auto cursor-pointer"
            title="Refresh deduplication metrics"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDedup ? 'animate-spin text-cyan-400' : ''}`} />
            <span>Refresh Metrics</span>
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3.5 bg-slate-950/70 rounded-xl border border-slate-800/90 space-y-1">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-blue-400" /> Logical Footprint
            </div>
            {renderStatValue(formatBytes(dedupStats?.totalLogicalBytes || 0), 'text-white')}
            <div className="text-[10px] text-slate-500">Unsharded user data</div>
          </div>

          <div className="p-3.5 bg-slate-950/70 rounded-xl border border-slate-800/90 space-y-1">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-purple-400" /> Physical Shards
            </div>
            {renderStatValue(formatBytes(dedupStats?.totalPhysicalBytes || 0), 'text-cyan-400')}
            <div className="text-[10px] text-slate-500">Dispersed to 6 nodes</div>
          </div>

          <div className="p-3.5 bg-slate-950/70 rounded-xl border border-slate-800/90 space-y-1">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> Avoided Storage
            </div>
            {renderStatValue(formatBytes(dedupStats?.savedBytes || 0), 'text-emerald-400')}
            <div className="text-[10px] text-emerald-500/90 font-mono">
              {!dedupStats && (isLoadingDedup || isLoading) ? (
                <span className="inline-block w-12 h-3 bg-slate-800 animate-pulse rounded" />
              ) : dedupStats?.savingsPercent ? (
                `+${dedupStats.savingsPercent}% saved`
              ) : (
                '0% saved'
              )}
            </div>
          </div>

          <div className="p-3.5 bg-slate-950/70 rounded-xl border border-slate-800/90 space-y-1">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" /> Efficiency Multiplier
            </div>
            {renderStatValue(dedupStats?.storageEfficiencyRatio ? `${dedupStats.storageEfficiencyRatio}x` : '1.00x', 'text-amber-400')}
            <div className="text-[10px] text-slate-500 font-mono">
              {!dedupStats && (isLoadingDedup || isLoading) ? (
                <span className="inline-block w-16 h-3 bg-slate-800 animate-pulse rounded" />
              ) : (
                `${dedupStats?.deduplicatedChunks || 0} / ${dedupStats?.totalChunks || 0} chunks reused`
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between text-xs font-mono text-slate-400 pt-2 border-t border-slate-800/80 gap-2">
          <div className="flex items-center gap-1.5 text-slate-300">
            <Layers className="w-3.5 h-3.5 text-purple-400" />
            <span>Chunk Reference Counting Engine Active:</span>
            <span className="text-slate-400">Shared physical shards preserved on file deletion</span>
          </div>
          <div className="text-cyan-400 font-semibold">
            {!dedupStats && (isLoadingDedup || isLoading) ? (
              <span className="inline-block w-12 h-3 bg-slate-800 animate-pulse rounded" />
            ) : (
              `${dedupStats?.totalChunks || 0} Stored Content Chunks`
            )}
          </div>
        </div>
      </GlassCard>

      {/* Filter and Search Bar Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
        {/* Category Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {[
            { id: 'all', label: 'All Files' },
            { id: 'pdf', label: 'PDF Documents' },
            { id: 'images', label: 'Images' },
            { id: 'docs', label: 'Text & Data' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setSelectedFilter(tab.id as any)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                selectedFilter === tab.id
                  ? 'bg-blue-600/20 text-cyan-300 border border-cyan-500/40 shadow-sm font-semibold'
                  : 'bg-slate-950/60 text-slate-400 border border-slate-800/80 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Grid/Table Toggle */}
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by name or hash..."
              className="w-full bg-slate-950/80 border border-slate-800/90 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-500/60 focus:outline-none transition-all"
            />
          </div>

          <div className="flex items-center bg-slate-950/80 border border-slate-800 rounded-xl p-1 shrink-0">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                viewMode === 'grid' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Grid View"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Table View"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Files Display */}
      {files.length === 0 && isLoading ? (
        <GlassCard className="p-16 text-center space-y-4">
          <Loader2 className="w-10 h-10 text-cyan-400 animate-spin mx-auto" />
          <div className="text-base font-bold text-white">Synchronizing Vault Mesh...</div>
          <div className="text-xs text-slate-400 max-w-sm mx-auto">
            Connecting to MongoDB Atlas cluster and querying distributed storage node catalogs...
          </div>
        </GlassCard>
      ) : filteredFiles.length === 0 ? (
        <GlassCard className="p-16 text-center space-y-3">
          <Lock className="w-10 h-10 text-slate-600 mx-auto" />
          <div className="text-base font-bold text-slate-300">
            {searchTerm ? 'No Matching Files Found' : 'Your Vault is Empty'}
          </div>
          <div className="text-xs text-slate-500 max-w-md mx-auto">
            {searchTerm
              ? `No files match query "${searchTerm}". Try a different search term or clear the filter.`
              : 'Zero files currently stored in this vault. Use the Ingest & Encrypt page to store files with AES-256-GCM and Reed-Solomon sharding.'}
          </div>
        </GlassCard>
      ) : viewMode === 'grid' ? (
        /* Grid View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredFiles.map((file) => {
            const formattedSize = typeof file.size === 'number' ? (file.size / 1024).toFixed(2) + ' KB' : (file.size || '0 KB');
            const totalShards = (file as any).totalShards || file.shardsCount || (file.cryptoVersion === 2 ? 6 : 4);
            const isCopied = copiedId === file.id;

            return (
              <GlassCard key={file.id} glow="blue" className="p-5 space-y-4 group">
                <div className="flex items-start justify-between">
                  <div className="w-11 h-11 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-center shadow-inner group-hover:border-cyan-500/40 transition-colors">
                    {getFileIcon(file.name)}
                  </div>
                  <button
                    onClick={() => handleTriggerViewShards(file)}
                    className="text-[10px] font-mono px-2.5 py-1 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <Layers className="w-3 h-3 text-purple-400" />
                    <span>Inspect {totalShards} Shards</span>
                  </button>
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <div
                      onClick={() => {
                        setSelectedFile(file);
                        setCurrentRoute('file-details');
                      }}
                      className="text-sm font-bold text-white cursor-pointer hover:text-cyan-400 transition-colors truncate"
                      title={file.name}
                    >
                      {file.name}
                    </div>
                    {file.isPasswordProtected && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-1 shrink-0" title="Password Protected">
                        <Lock className="w-2.5 h-2.5" /> Protected
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono mt-1">
                    <span className="text-white font-semibold">{formattedSize}</span>
                    <span>•</span>
                    <span className="text-cyan-400">AES-256-GCM</span>
                    <span>•</span>
                    <span className="text-slate-500">{file.encryptedAt ? new Date(file.encryptedAt).toLocaleDateString() : 'Active'}</span>
                  </div>
                </div>

                {/* Fingerprint / Hash pill */}
                {file.hash && (
                  <div 
                    onClick={() => handleCopyHash(file.hash, file.id)}
                    className="p-2 bg-slate-950/70 hover:bg-slate-900/90 rounded-lg border border-slate-800/80 text-[10px] font-mono text-slate-400 flex items-center justify-between cursor-pointer transition-colors"
                    title="Click to copy SHA-256 hash"
                  >
                    <span className="truncate max-w-[220px]">
                      Hash: <span className="text-slate-300">{file.hash.substring(0, 18)}...</span>
                    </span>
                    {isCopied ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-slate-500 hover:text-slate-300 shrink-0" />
                    )}
                  </div>
                )}

                {/* Action Buttons Toolbar */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-800/80 gap-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleTriggerDownload(file)}
                      className="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600 hover:text-white text-blue-400 transition-all text-xs flex items-center gap-1.5 font-medium border border-blue-500/30 cursor-pointer shadow-sm"
                    >
                      <Download className="w-3.5 h-3.5" /> Download
                    </button>

                    <button
                      onClick={() => handleTriggerShare(file)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/15 hover:bg-emerald-600 hover:text-white text-emerald-400 transition-all text-xs flex items-center gap-1.5 font-medium border border-emerald-500/30 cursor-pointer"
                      title="Generate Secure Share Link"
                    >
                      <Share2 className="w-3.5 h-3.5" /> Share
                    </button>
                  </div>

                  <button
                    onClick={() => handleDeleteWithRefresh(file.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 border border-slate-800 hover:border-red-500/30 transition-all cursor-pointer"
                    title="Permanently Shred File and Shards"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </GlassCard>
            );
          })}
        </div>
      ) : (
        /* Table View */
        <GlassCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-mono text-[11px] uppercase">
                <tr>
                  <th className="py-3 px-4">File Name</th>
                  <th className="py-3 px-4">Size</th>
                  <th className="py-3 px-4">Encryption & Sharding</th>
                  <th className="py-3 px-4">Fingerprint</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredFiles.map((file) => {
                  const formattedSize = typeof file.size === 'number' ? (file.size / 1024).toFixed(2) + ' KB' : (file.size || '0 KB');
                  const totalShards = (file as any).totalShards || file.shardsCount || (file.cryptoVersion === 2 ? 6 : 4);
                  const isCopied = copiedId === file.id;

                  return (
                    <tr key={file.id} className="hover:bg-slate-900/50 transition-colors group">
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                            {getFileIcon(file.name)}
                          </div>
                          <div className="truncate max-w-[200px]">
                            <div 
                              onClick={() => {
                                setSelectedFile(file);
                                setCurrentRoute('file-details');
                              }}
                              className="font-bold text-white hover:text-cyan-400 cursor-pointer truncate"
                            >
                              {file.name}
                            </div>
                            {file.isPasswordProtected && (
                              <span className="text-[10px] text-purple-400 font-mono flex items-center gap-1">
                                <Lock className="w-2.5 h-2.5" /> Password Protected
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 font-mono font-semibold text-slate-200">
                        {formattedSize}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5 font-mono text-[11px]">
                          <span className="px-2 py-0.5 rounded bg-blue-500/10 text-cyan-400 border border-blue-500/20">
                            AES-256-GCM
                          </span>
                          <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                            RS {totalShards} Shards
                          </span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 font-mono text-[11px] text-slate-400">
                        {file.hash ? (
                          <button
                            onClick={() => handleCopyHash(file.hash, file.id)}
                            className="flex items-center gap-1.5 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="Click to copy full hash"
                          >
                            <span>{file.hash.substring(0, 14)}...</span>
                            {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-500" />}
                          </button>
                        ) : (
                          'N/A'
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-slate-400 text-[11px] font-mono">
                        {file.encryptedAt ? new Date(file.encryptedAt).toLocaleDateString() : 'Active'}
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleTriggerViewShards(file)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-purple-300 hover:bg-purple-500/10 transition-colors cursor-pointer"
                            title="Inspect Shards"
                          >
                            <Layers className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleTriggerDownload(file)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors cursor-pointer"
                            title="Download & Decrypt"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleTriggerShare(file)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors cursor-pointer"
                            title="Create Share Link"
                          >
                            <Share2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteWithRefresh(file.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}
    </div>
  );
};
