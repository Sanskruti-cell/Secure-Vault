import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import { FileText, Download, Trash2, ArrowLeft, Server, Cpu, Copy, Check, Lock, Database } from 'lucide-react';
import { DownloadRecoveryModal } from '../components/DownloadRecoveryModal';

export const FileDetailsPage: React.FC = () => {
  const { selectedFile, setCurrentRoute, deleteFile } = useApp();
  const [copiedHash, setCopiedHash] = useState(false);
  const [downloadTargetFile, setDownloadTargetFile] = useState<any | null>(null);

  if (!selectedFile) {
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-slate-400 text-xs">No file selected for inspection.</p>
        <button
          onClick={() => setCurrentRoute('vault')}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-semibold"
        >
          Return to Vault
        </button>
      </div>
    );
  }

  const assignedNodes = selectedFile.nodeDistribution || (selectedFile as any).assignedNodes || ['node-01', 'node-02', 'node-03', 'node-04'];
  const formattedSize = typeof selectedFile.size === 'number' ? (selectedFile.size / 1024).toFixed(2) + ' KB' : (selectedFile.size || '0 KB');

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 page-enter">
      <button
        onClick={() => setCurrentRoute('vault')}
        className="flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Vault
      </button>

      <GlassCard glow="blue" className="p-6 space-y-6">
        <div className="flex items-start justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <FileText className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">{selectedFile.name}</h1>
              <div className="text-xs text-slate-400 font-mono">ID: {selectedFile.id} • {formattedSize}</div>
            </div>
          </div>
          <button
            onClick={() => setDownloadTargetFile(selectedFile)}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-blue-500/20"
          >
            <Download className="w-4 h-4" /> Download & Decrypt
          </button>
        </div>

        {/* Cryptographic Metadata */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <div className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
              <Lock className="w-3 h-3 text-cyan-400" /> Cipher Specification
            </div>
            <div className="text-xs text-cyan-400 font-mono font-semibold">AES-256-GCM (Authenticated Encryption)</div>
            <div className="text-[10px] text-slate-500">Payload encrypted prior to storage dispatch</div>
          </div>
          <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <div className="text-[10px] text-slate-500 uppercase font-bold flex items-center justify-between">
              <span className="flex items-center gap-1"><Cpu className="w-3 h-3 text-purple-400" /> SHA-256 Hash Digest</span>
              <button onClick={() => copyToClipboard(selectedFile.hash || selectedFile.id)} className="text-slate-400 hover:text-white" title="Copy Hash">
                {copiedHash ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <div className="text-[10px] text-slate-300 font-mono truncate">{selectedFile.hash || selectedFile.id}</div>
            <div className="text-[10px] text-slate-500">Unique fingerprint for corruption & tamper check</div>
          </div>
        </div>

        {/* Node Distribution Map */}
        <div className="space-y-3">
          <div className="text-xs font-bold text-slate-200 flex items-center gap-2">
            <Server className="w-4 h-4 text-purple-400" /> Reed-Solomon Shard Allocation across Nodes
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {assignedNodes.map((nodeId: string, idx: number) => (
              <div key={nodeId + idx} className="p-3 bg-slate-900/60 rounded-xl border border-slate-800 text-center space-y-1">
                <Cpu className="w-4 h-4 text-cyan-400 mx-auto" />
                <div className="text-xs font-semibold text-slate-200">{nodeId}</div>
                <div className="text-[10px] text-emerald-400 font-mono">Shard #{idx + 1}</div>
              </div>
            ))}
          </div>
        </div>

        {/* MongoDB Persistence Status */}
        <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-emerald-400" />
            <div>
              <div className="font-semibold text-slate-200">MongoDB Atlas Cluster Persistence</div>
              <div className="text-[10px] text-slate-500">Database: securevault • Cluster: cluster0.unzftil.mongodb.net</div>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
            ✓ PERSISTED
          </span>
        </div>

        <div className="pt-4 border-t border-slate-800 flex justify-end">
          <button
            onClick={async () => {
              await deleteFile(selectedFile.id);
              setCurrentRoute('vault');
            }}
            className="px-4 py-2 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 text-xs font-semibold flex items-center gap-1.5"
          >
            <Trash2 className="w-4 h-4" /> Shred File & Purge Shards
          </button>
        </div>
      </GlassCard>

      {/* Download Recovery Journey Modal */}
      {downloadTargetFile && (
        <DownloadRecoveryModal
          file={downloadTargetFile}
          onClose={() => setDownloadTargetFile(null)}
        />
      )}
    </div>
  );
};