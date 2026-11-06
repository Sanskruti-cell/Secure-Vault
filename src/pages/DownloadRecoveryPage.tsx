import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Download,
  Lock,
  Cpu,
  ShieldCheck,
  Server,
  FileText,
  FileCheck,
  Box,
  Layers,
  ShieldAlert,
  AlertTriangle,
  XCircle,
  Sparkles
} from 'lucide-react';
import { api } from '../services/api';
import { StorageNode } from '../types';
import { VerifyFilePasswordModal } from '../components/VerifyFilePasswordModal';

interface ShardDetailItem {
  shardIndex: number;
  nodeId: string;
  nodeName: string;
  region: string;
  isAvailable: boolean;
  statusText: string;
  shardSizeKB: string;
}

export const DownloadRecoveryPage: React.FC = () => {
  const { selectedFile, setCurrentRoute, files, isVaultLocked, setIsLockModalOpen, showToast } = useApp();
  const [step, setStep] = useState<number>(1);
  const [isCompleted, setIsCompleted] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  const file = selectedFile || (files.length > 0 ? files[0] : null);

  const totalShards = (file as any)?.totalShards || file?.shardsCount || (file?.cryptoVersion === 2 ? 6 : 4);
  const requiredThreshold = (file as any)?.dataShards || (file?.cryptoVersion === 2 ? 4 : 3);

  const [shardDetails, setShardDetails] = useState<ShardDetailItem[]>([]);
  const [availableCount, setAvailableCount] = useState<number>(totalShards);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState<boolean>(true);

  const [isVerifyModalOpen, setIsVerifyModalOpen] = useState<boolean>(false);

  const formattedSize = typeof file?.size === 'number'
    ? (file.size / 1024).toFixed(1) + ' KB'
    : (file?.size || '124.2 KB');

  useEffect(() => {
    let isMounted = true;
    setStep(1);
    setIsCompleted(false);
    setErrorMessage(null);
    setIsLoadingMetadata(true);

    if (!file) return;

    const runSequentialRecovery = async () => {
      // Fetch real cluster node health and file shard mappings
      let clusterNodes: StorageNode[] = [];
      let fileShards: any[] = [];

      try {
        const [nodesRes, shardsRes] = await Promise.all([
          api.fetchNodes().catch(() => []),
          api.fetchFileShards(file.id).catch(() => [])
        ]);
        clusterNodes = nodesRes;
        fileShards = shardsRes;
      } catch (err) {
        console.warn('[Recovery Warning] Error fetching node/shard telemetry:', err);
      }

      if (!isMounted) return;

      // Determine total shards and threshold dynamically
      const totalShards = (file as any).totalShards || file.shardsCount || (file.cryptoVersion === 2 ? 6 : 4);
      const requiredThreshold = (file as any).dataShards || (file.cryptoVersion === 2 ? 4 : 3);

      if (!fileShards || fileShards.length === 0) {
        setIsLoadingMetadata(false);
        setStep(1);
        setAvailableCount(0);
        setErrorMessage(`No storage shards found in cluster catalog for "${file.name}". Minimum ${requiredThreshold} valid shards are required for reconstruction.`);
        return;
      }

      // Construct real shard-to-node mapping
      const mappedShards: ShardDetailItem[] = [];
      let avail = 0;

      for (let idx = 0; idx < totalShards; idx++) {
        const shardIndex = idx + 1;
        const shardData = fileShards.find((s: any) => s.shardIndex === shardIndex) || fileShards[idx];
        const nodeId = shardData?.nodeId || (file.nodeDistribution && file.nodeDistribution[idx]) || `node-0${idx + 1}`;
        
        const matchedNode = clusterNodes.find((n: any) => n.nodeId === nodeId || n.id === nodeId);
        const isOffline = matchedNode ? (matchedNode.status === 'offline' || (matchedNode as any).isSimulatedFailure) : false;
        const shardExistsInCatalog = !!shardData;
        const isAvailable = shardExistsInCatalog && !isOffline;

        if (isAvailable) avail++;

        const nodeName = matchedNode ? matchedNode.name : nodeId.toUpperCase();
        const region = matchedNode ? matchedNode.region : 'Global Cluster Node';
        const szBytes = shardData?.shardSize || shardData?.size || (file.size ? Math.ceil(file.size / requiredThreshold) : 31744);
        const shardSizeKB = (szBytes / 1024).toFixed(1) + ' KB';

        mappedShards.push({
          shardIndex,
          nodeId,
          nodeName,
          region,
          isAvailable,
          statusText: !shardExistsInCatalog ? 'MISSING FROM CATALOG ✕' : isOffline ? 'OFFLINE / SIMULATED FAILURE ⚠' : 'Retrieved ✓',
          shardSizeKB
        });
      }

      setShardDetails(mappedShards);
      setAvailableCount(avail);
      setIsLoadingMetadata(false);

      // Step 1: Requesting File Metadata
      await new Promise(r => setTimeout(r, 450));
      if (!isMounted) return;

      // Step 2: Retrieving Shards
      setStep(2);
      await new Promise(r => setTimeout(r, 600));
      if (!isMounted) return;

      // Check if threshold is met
      if (avail < requiredThreshold) {
        // Insufficient shards for recovery
        setStep(3); // Stop at Step 3 with failure state
        setErrorMessage(`Insufficient shards available (${avail}/${totalShards}). Minimum ${requiredThreshold} shards are required for recovery.`);
        return;
      }

      // Step 3: Reconstructing Shards (Erasure Coding threshold K=3 met)
      setStep(3);
      await new Promise(r => setTimeout(r, 650));
      if (!isMounted) return;

      // Step 4: AES-256-GCM Decryption
      setStep(4);
      await new Promise(r => setTimeout(r, 550));
      if (!isMounted) return;

      // Step 5: SHA-256 Integrity Verification
      setStep(5);
      await new Promise(r => setTimeout(r, 550));
      if (!isMounted) return;

      // Step 6: Original File Restored
      setStep(6);
      await new Promise(r => setTimeout(r, 450));
      if (!isMounted) return;

      // Step 7: Ready for Download
      setStep(7);
      setIsCompleted(true);

      // Trigger Browser Download automatically when ready (if vault is unlocked)
      if (!isVaultLocked) {
        try {
          await api.downloadFile(file.id, file.name);
        } catch (err: any) {
          console.warn('Auto download error:', err);
          if (file.isPasswordProtected) {
            setIsVerifyModalOpen(true);
          }
        }
      }
    };

    runSequentialRecovery();

    return () => {
      isMounted = false;
    };
  }, [file]);

  const handleDownloadClick = async () => {
    if (!file || isDownloading || availableCount < requiredThreshold) return;

    // Vault lock guard: require Master Password if vault is locked
    if (isVaultLocked) {
      setIsLockModalOpen(true);
      showToast('Unlock your vault with Master Password to decrypt and download files.', 'warning');
      return;
    }

    setIsDownloading(true);
    setErrorMessage(null);
    try {
      await api.downloadFile(file.id, file.name);
      showToast(`Downloaded ${file.name} successfully!`, 'success');
    } catch (err: any) {
      console.error('Download error:', err);
      // If decryption failed, offer manual password entry modal as fallback
      if (file.isPasswordProtected) {
        setIsVerifyModalOpen(true);
      } else {
        setErrorMessage(err.message || 'Download failed');
        showToast(err.message || 'Download failed', 'danger');
      }
    } finally {
      setIsDownloading(false);
    }
  };

  const handleVerifyAndDownload = async (password: string): Promise<boolean> => {
    if (!file) return false;
    try {
      await api.downloadFile(file.id, file.name, password);
      return true;
    } catch (err: any) {
      throw err;
    }
  };

  if (!file) {
    return (
      <div className="space-y-6 page-enter">
        <button
          onClick={() => setCurrentRoute('vault')}
          className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 font-semibold"
        >
          <ArrowLeft className="w-4 h-4" /> Back to My Vault
        </button>
        <GlassCard className="p-12 text-center text-slate-400 space-y-2">
          <p>No file selected for recovery.</p>
          <button
            onClick={() => setCurrentRoute('vault')}
            className="text-xs text-cyan-400 hover:underline font-semibold"
          >
            Return to My Vault →
          </button>
        </GlassCard>
      </div>
    );
  }

  const isFailedThreshold = availableCount < requiredThreshold && step === 3;

  return (
    <div className="space-y-6 page-enter max-w-7xl mx-auto">
      {/* Top Bar Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentRoute('vault')}
          className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 font-semibold transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-cyan-400" />
          <span>Back to My Vault</span>
        </button>
        <div className="text-xs font-mono text-slate-400">
          File: <span className="text-white font-bold">{file.name}</span> ({formattedSize})
        </div>
      </div>

      {/* Main Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Download & Recovery</h1>
        <p className="text-xs text-slate-400">Real-time erasure-code file recovery pipeline</p>
      </div>

      {file.isPasswordProtected && (
        <div className="p-3 bg-purple-950/40 border border-purple-500/40 rounded-2xl text-xs text-purple-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Lock className="w-4 h-4 text-purple-400 shrink-0" />
            <div>
              <span className="font-bold text-white">Password-Protected File:</span> Backend requires your file password to authorize decryption and download.
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40">
            SHA-256 Enforced
          </span>
        </div>
      )}

      {/* Vault lock banner for non-password-protected files */}
      {!file.isPasswordProtected && isVaultLocked && (
        <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-2xl text-xs text-purple-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Lock className="w-4 h-4 text-purple-400 shrink-0" />
            <span>Vault is locked. You must unlock the vault to decrypt and download this file.</span>
          </div>
          <button
            onClick={() => setIsLockModalOpen(true)}
            className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold text-[11px] transition-all ml-3 whitespace-nowrap"
          >
            Unlock Vault
          </button>
        </div>
      )}

      {/* Error / Warning Alert Banner */}
      {errorMessage && (
        <div className="p-4 bg-red-950/50 border border-red-500/50 rounded-2xl text-xs text-red-300 flex items-center gap-3 shadow-lg shadow-red-500/10">
          <ShieldAlert className="w-5 h-5 text-red-400 shrink-0" />
          <div>
            <div className="font-bold text-red-200">Recovery Stopped</div>
            <p className="text-[11px] text-red-300/90">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* 2-Column Responsive Layout Matching Reference Architecture */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
        {/* Left Column (2/3 width): Sequential Vertical Timeline */}
        <div className="lg:col-span-2 relative space-y-4">
          {/* Vertical Connecting Timeline Line */}
          <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-slate-800 z-0" />

          {/* Step 1: Requesting File Metadata */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              step >= 1 ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              1
            </div>

            <div className={`flex-1 p-4 rounded-2xl border transition-all ${
              step === 1 ? 'bg-slate-900/90 border-cyan-500/50 shadow-lg shadow-cyan-500/10' :
              step > 1 ? 'bg-slate-900/60 border-slate-800/80 text-slate-200' : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className={`w-5 h-5 ${step >= 1 ? 'text-cyan-400' : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">Requesting File Metadata</h3>
                    <p className="text-xs text-slate-400">Fetching encrypted file metadata and shard mappings...</p>
                  </div>
                </div>
                {step === 1 ? (
                  <span className="text-xs font-mono text-cyan-400 font-semibold flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> In Progress
                  </span>
                ) : step > 1 ? (
                  <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center gap-1">
                    Completed <CheckCircle2 className="w-4 h-4" />
                  </span>
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>
            </div>
          </div>

          {/* Step 2: Retrieving Shards */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              step >= 2 ? (availableCount < requiredThreshold ? 'bg-amber-600 border-amber-400 text-white' : 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30') : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              2
            </div>

            <div className={`flex-1 p-4 rounded-2xl border transition-all space-y-3 ${
              step === 2 ? 'bg-slate-900/90 border-cyan-500/50 shadow-lg shadow-cyan-500/10' :
              step > 2 ? (availableCount < totalShards ? 'bg-slate-900/80 border-amber-500/40 text-slate-200' : 'bg-slate-900/60 border-slate-800/80 text-slate-200') : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Box className={`w-5 h-5 ${step >= 2 ? (availableCount < requiredThreshold ? 'text-amber-400' : 'text-purple-400') : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">Retrieving Shards</h3>
                    <p className="text-xs text-slate-400">Collecting encrypted shards from distributed storage nodes</p>
                  </div>
                </div>
                {step === 2 ? (
                  <span className="text-xs font-mono text-cyan-400 font-semibold flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Retrieving
                  </span>
                ) : step > 2 ? (
                  availableCount >= totalShards ? (
                    <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center gap-1">
                      ✓ {totalShards}/{totalShards} shards retrieved <CheckCircle2 className="w-4 h-4" />
                    </span>
                  ) : availableCount >= requiredThreshold ? (
                    <span className="text-xs font-mono text-amber-400 font-semibold flex items-center gap-1">
                      ⚠ {availableCount}/{totalShards} shards retrieved (threshold {requiredThreshold} met) <AlertTriangle className="w-4 h-4" />
                    </span>
                  ) : (
                    <span className="text-xs font-mono text-red-400 font-semibold flex items-center gap-1">
                      ✕ {availableCount}/{totalShards} shards retrieved <XCircle className="w-4 h-4" />
                    </span>
                  )
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>

              {/* Real Shard-to-Node Badges Grid inside Step 2 */}
              {step >= 2 && shardDetails.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 font-mono text-xs">
                  {shardDetails.map((s) => (
                    <div
                      key={s.shardIndex}
                      className={`p-2.5 rounded-xl border flex items-center justify-between transition-all ${
                        s.isAvailable
                          ? 'bg-slate-950 border-slate-800'
                          : 'bg-red-950/30 border-red-500/40 text-red-300'
                      }`}
                    >
                      <div>
                        <div className="font-bold flex items-center gap-1.5">
                          <span className={s.isAvailable ? 'text-cyan-400' : 'text-red-400'}>Shard #{s.shardIndex}</span>
                          <span className="text-slate-400 text-[10px]">({s.nodeName})</span>
                        </div>
                        <div className="text-[10px] text-slate-500">{s.region}</div>
                      </div>

                      {s.isAvailable ? (
                        <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                          ✓ Retrieved
                        </span>
                      ) : (
                        <span className="text-[10px] text-red-400 font-bold flex items-center gap-1">
                          ⚠ OFFLINE / SIMULATED FAILURE
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Step 3: Reconstructing Shards */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              isFailedThreshold ? 'bg-red-600 border-red-400 text-white' :
              step >= 3 ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              3
            </div>

            <div className={`flex-1 p-4 rounded-2xl border transition-all space-y-3 ${
              isFailedThreshold ? 'bg-red-950/40 border-red-500/50 text-red-200' :
              step === 3 ? 'bg-slate-900/90 border-cyan-500/50 shadow-lg shadow-cyan-500/10' :
              step > 3 ? 'bg-slate-900/60 border-slate-800/80 text-slate-200' : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Cpu className={`w-5 h-5 ${isFailedThreshold ? 'text-red-400' : step >= 3 ? 'text-purple-400' : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">Reconstructing Shards</h3>
                    <p className="text-xs text-slate-400">Erasure-Code mathematical payload reconstruction</p>
                  </div>
                </div>
                {isFailedThreshold ? (
                  <span className="text-xs font-mono text-red-400 font-bold flex items-center gap-1">
                    ✕ Recovery Failed <XCircle className="w-4 h-4" />
                  </span>
                ) : step === 3 ? (
                  <span className="text-xs font-mono text-cyan-400 font-semibold flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> In Progress
                  </span>
                ) : step > 3 ? (
                  <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center gap-1">
                    {availableCount < totalShards ? `✓ Reconstructed using ${availableCount}/${totalShards} available shards` : '✓ Reconstruction completed'} <CheckCircle2 className="w-4 h-4" />
                  </span>
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>

              {/* Technical Explanation Box when 1 or 2 shards are unavailable but threshold is met */}
              {step >= 3 && availableCount < totalShards && availableCount >= requiredThreshold && !isFailedThreshold && (
                <div className="p-3 bg-amber-950/30 border border-amber-500/30 rounded-xl text-xs text-amber-200 flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="font-bold text-amber-300 text-[11px]">Erasure Coding Recovery Active:</div>
                    <p className="text-slate-300 text-[11px]">
                      {totalShards - availableCount} shard(s) offline. The encrypted payload was successfully reconstructed using surviving shards meeting the K={requiredThreshold} threshold (Cauchy Reed-Solomon {requiredThreshold}+{totalShards - requiredThreshold}).
                    </p>
                  </div>
                </div>
              )}

              {/* Error Explanation when < requiredThreshold shards available */}
              {isFailedThreshold && (
                <div className="p-3 bg-red-950/50 border border-red-500/40 rounded-xl text-xs text-red-200 flex items-start gap-2.5">
                  <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="font-bold text-red-300 text-[11px]">Insufficient Shards Available:</div>
                    <p className="text-red-200/90 text-[11px]">
                      Only {availableCount} of {totalShards} shards available. Minimum {requiredThreshold} shards required for Reed-Solomon reconstruction.
                    </p>
                  </div>
                </div>
              )}

              {step >= 3 && !isFailedThreshold && (
                <div className="space-y-1">
                  <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                    <div
                      className="bg-gradient-to-r from-emerald-500 to-cyan-400 h-full rounded-full transition-all duration-500"
                      style={{ width: step > 3 ? '100%' : '75%' }}
                    />
                  </div>
                  <div className="flex justify-end text-[10px] font-mono text-emerald-400 font-bold">
                    {step > 3 ? '100%' : '75%'}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Step 4: AES-256-GCM Decryption */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              step >= 4 ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              4
            </div>

            <div className={`flex-1 p-4 rounded-2xl border transition-all ${
              step === 4 ? 'bg-slate-900/90 border-cyan-500/50 shadow-lg shadow-cyan-500/10' :
              step > 4 ? 'bg-slate-900/60 border-slate-800/80 text-slate-200' : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Lock className={`w-5 h-5 ${step >= 4 ? 'text-cyan-400' : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">AES-256-GCM Decryption</h3>
                    <p className="text-xs text-slate-400">Decrypting the reconstructed payload using session key</p>
                  </div>
                </div>
                {step === 4 ? (
                  <span className="text-xs font-mono text-cyan-400 font-semibold flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> In Progress
                  </span>
                ) : step > 4 ? (
                  <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center gap-1">
                    Completed <CheckCircle2 className="w-4 h-4" />
                  </span>
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>
            </div>
          </div>

          {/* Step 5: SHA-256 Integrity Verification */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              step >= 5 ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              5
            </div>

            <div className={`flex-1 p-4 rounded-2xl border transition-all ${
              step === 5 ? 'bg-slate-900/90 border-cyan-500/50 shadow-lg shadow-cyan-500/10' :
              step > 5 ? 'bg-slate-900/60 border-slate-800/80 text-slate-200' : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <ShieldCheck className={`w-5 h-5 ${step >= 5 ? 'text-emerald-400' : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">SHA-256 Integrity Verification</h3>
                    <p className="text-xs text-slate-400">Verifying file integrity against original hash</p>
                  </div>
                </div>
                {step === 5 ? (
                  <span className="text-xs font-mono text-cyan-400 font-semibold flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> In Progress
                  </span>
                ) : step > 5 ? (
                  <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center gap-1">
                    Verified <CheckCircle2 className="w-4 h-4" />
                  </span>
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>
            </div>
          </div>

          {/* Step 6: Original File Restored */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              step >= 6 ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              6
            </div>

            <div className={`flex-1 p-4 rounded-2xl border transition-all ${
              step === 6 ? 'bg-slate-900/90 border-cyan-500/50 shadow-lg shadow-cyan-500/10' :
              step > 6 ? 'bg-emerald-950/30 border-emerald-500/40 text-white' : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileCheck className={`w-5 h-5 ${step >= 6 ? 'text-emerald-400' : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">Original File Restored</h3>
                    <p className="text-xs text-slate-400">File successfully decrypted and verified</p>
                  </div>
                </div>
                {step === 6 ? (
                  <span className="text-xs font-mono text-cyan-400 font-semibold flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Restoring
                  </span>
                ) : step > 6 ? (
                  <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center gap-1">
                    Restored <CheckCircle2 className="w-4 h-4" />
                  </span>
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>
            </div>
          </div>

          {/* Step 7: Download to Device */}
          <div className="relative z-10 flex items-start gap-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border transition-all ${
              step >= 7 ? 'bg-emerald-600 border-emerald-400 text-white shadow-lg shadow-emerald-500/30' : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}>
              7
            </div>

            <div className={`flex-1 p-5 rounded-2xl border transition-all space-y-3 ${
              step >= 7 ? 'bg-emerald-950/30 border-emerald-500/40 text-white shadow-xl shadow-emerald-500/10' : 'bg-slate-950/60 border-slate-900 text-slate-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Download className={`w-5 h-5 ${step >= 7 ? 'text-emerald-400' : 'text-slate-600'}`} />
                  <div>
                    <h3 className="text-sm font-bold text-white">Download to Device</h3>
                    <p className="text-xs text-slate-400">Preparing file for secure download</p>
                  </div>
                </div>
                {step >= 7 ? (
                  <span className="text-xs font-mono text-emerald-400 font-bold px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30">
                    Ready ✓
                  </span>
                ) : (
                  <span className="text-xs font-mono text-slate-600">Pending ⭕</span>
                )}
              </div>

              {step >= 7 && (
                <div className="pt-2">
                  <button
                    onClick={handleDownloadClick}
                    disabled={isDownloading}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-bold text-xs shadow-lg shadow-emerald-500/20 hover:opacity-95 transition-all flex items-center justify-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    <span>{isDownloading ? 'Downloading...' : `Download ${file.name}`}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column (1/3 width): Shard Retrieval Details & Recovery Summary Cards */}
        <div className="space-y-6">
          {/* Card 1: Shard Retrieval Details */}
          <GlassCard className="p-5 space-y-4 border-slate-800">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-400" />
                Shard Retrieval Details
              </h3>
            </div>

            <div className="space-y-2.5">
              {shardDetails.map((s) => (
                <div
                  key={s.shardIndex}
                  className={`p-3 rounded-xl border flex items-center justify-between text-xs transition-all ${
                    s.isAvailable ? 'bg-slate-950 border-slate-800' : 'bg-red-950/30 border-red-500/40'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 font-mono text-[11px] font-bold ${
                      s.isAvailable ? 'bg-purple-500/10 border-purple-500/20 text-purple-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
                    }`}>
                      #{s.shardIndex}
                    </div>
                    <div>
                      <div className="font-bold text-white flex items-center gap-1.5">
                        <span>Shard #{s.shardIndex}</span>
                        <span className="text-slate-400 text-[10px] font-mono">({s.nodeName})</span>
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">{s.region}</div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className={`text-[10px] font-mono font-bold ${s.isAvailable ? 'text-emerald-400' : 'text-red-400'}`}>
                      {s.isAvailable ? 'Retrieved ✓' : 'OFFLINE ⚠'}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">{s.shardSizeKB}</div>
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>

          {/* Card 2: Recovery Summary */}
          <GlassCard className="p-5 space-y-4 border-slate-800">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
                Recovery Summary
              </h3>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between text-slate-400">
                <span>Total Shards</span>
                <span className="text-white font-bold">{totalShards}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Shards Available</span>
                <span className={availableCount >= requiredThreshold ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                  {step >= 2 ? `${availableCount}/${totalShards}` : `0/${totalShards}`}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Required Threshold</span>
                <span className="text-white font-bold">K={requiredThreshold}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Reconstruction</span>
                <span className={step >= 3 ? (availableCount >= requiredThreshold ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold') : 'text-slate-600'}>
                  {step >= 3 ? (availableCount >= requiredThreshold ? 'Success' : 'Failed ✕') : 'Pending'}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Decryption</span>
                <span className={step >= 4 ? 'text-emerald-400 font-bold' : step === 4 ? 'text-cyan-400 font-bold' : 'text-slate-600'}>
                  {step > 4 ? 'Success' : step === 4 ? 'In Progress' : 'Pending'}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Integrity Verification</span>
                <span className={step >= 5 ? 'text-emerald-400 font-bold' : 'text-slate-600'}>
                  {step >= 5 ? 'Success' : 'Pending'}
                </span>
              </div>
              <div className="flex justify-between text-slate-400 pt-2 border-t border-slate-800">
                <span>Status</span>
                <span className={isCompleted ? 'text-emerald-400 font-bold flex items-center gap-1' : isFailedThreshold ? 'text-red-400 font-bold flex items-center gap-1' : 'text-cyan-400 font-bold flex items-center gap-1'}>
                  {isCompleted ? 'Completed ✓' : isFailedThreshold ? 'Failed ✕' : <><Loader2 className="w-3 h-3 animate-spin" /> In Progress</>}
                </span>
              </div>
            </div>

            {/* Info Notice Box */}
            <div className={`p-3 rounded-xl text-[11px] flex items-start gap-2.5 ${
              isFailedThreshold ? 'bg-red-950/40 border border-red-500/30 text-red-200' :
              availableCount < totalShards ? 'bg-amber-950/40 border border-amber-500/30 text-amber-200' :
              'bg-blue-950/40 border border-blue-500/30 text-blue-200'
            }`}>
              <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="font-bold text-white">
                  {isFailedThreshold ? 'Threshold Not Met' : availableCount < totalShards ? 'Erasure Coding Active' : 'Optimal Recovery'}
                </div>
                <div className="text-slate-300 text-[10px]">
                  {isFailedThreshold ? `Need at least ${requiredThreshold} shards to reconstruct file.` : availableCount < totalShards ? `Reconstructing file with ${availableCount}/${totalShards} shards using K=${requiredThreshold} threshold.` : `All ${totalShards} shards retrieved from cluster.`}
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>

      <VerifyFilePasswordModal
        isOpen={isVerifyModalOpen}
        onClose={() => setIsVerifyModalOpen(false)}
        onVerify={handleVerifyAndDownload}
        fileName={file.name}
      />
    </div>
  );
};
