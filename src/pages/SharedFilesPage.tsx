import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import { Share2, Lock, Copy, Trash2, Clock, Download, ShieldCheck, Check } from 'lucide-react';

export const SharedFilesPage: React.FC = () => {
  const { sharedLinks, showToast, revokeShareLink } = useApp();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const getShareUrl = (share: any) => {
    const origin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : 'http://localhost:5173';
    let url = `${origin}/share/${share.token || share.id}`;
    const key = localStorage.getItem(`sv_share_key_${share.token || share.id}`);
    if (key && !share.isPasswordProtected) {
      url += `#key=${key}`;
    }
    return url;
  };

  const handleCopy = (shareId: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(shareId);
    showToast('Share URL copied to clipboard', 'success');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRevoke = async (shareId: string) => {
    if (!window.confirm('Are you sure you want to revoke this share link? Recipient access will be immediately terminated.')) {
      return;
    }
    setRevokingId(shareId);
    await revokeShareLink(shareId);
    setRevokingId(null);
  };

  return (
    <div className="space-y-6 page-enter">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Share2 className="w-6 h-6 text-blue-400" /> Active Share Links
          </h1>
          <p className="text-xs text-slate-400">Zero-Knowledge Time-Limited Sharing Tokens</p>
        </div>
      </div>

      {sharedLinks.length === 0 ? (
        <GlassCard className="p-12 text-center space-y-3">
          <Share2 className="w-10 h-10 text-slate-600 mx-auto" />
          <div className="text-sm font-semibold text-slate-300">No active share links</div>
          <div className="text-xs text-slate-500">Generate encrypted zero-knowledge share links from My Vault page</div>
        </GlassCard>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sharedLinks.map((share) => {
            const isRevoked = share.status === 'revoked';
            const isExpired = share.status === 'expired' || new Date() > new Date(share.expiresAt);
            const statusLabel = isRevoked ? 'Revoked' : (isExpired ? 'Expired' : 'Active');
            const statusColor = isRevoked
              ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
              : (isExpired
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20');

            const shareId = share.token || share.id;
            const displayUrl = getShareUrl(share);

            return (
              <GlassCard key={shareId} glow={isRevoked ? 'none' : (isExpired ? 'none' : 'blue')} className="p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 overflow-hidden">
                    <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-cyan-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <div className="overflow-hidden">
                      <div className="text-sm font-bold text-white truncate">{share.fileName}</div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {share.fileSize ? `${(share.fileSize / 1024).toFixed(1)} KB • ` : ''}Reed-Solomon 4+2
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {share.isPasswordProtected && (
                      <span className="text-[9px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        Passphrase
                      </span>
                    )}
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${statusColor}`}>
                      {statusLabel}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
                  <span className="text-xs text-cyan-400 font-mono truncate">{displayUrl}</span>
                  <button
                    onClick={() => handleCopy(shareId, displayUrl)}
                    disabled={isRevoked || isExpired}
                    title="Copy Share URL"
                    className="p-1.5 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1 shrink-0"
                  >
                    {copiedId === shareId ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2.5">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-slate-500" />
                      Expires: {new Date(share.expiresAt).toLocaleDateString()}
                    </span>
                    <span className="flex items-center gap-1 font-mono">
                      <Download className="w-3.5 h-3.5 text-slate-500" />
                      {share.downloadCount || share.accessCount || 0} / {share.downloadLimit || share.maxAccess || 10}
                    </span>
                  </div>

                  {!isRevoked && (
                    <button
                      onClick={() => handleRevoke(shareId)}
                      disabled={revokingId === shareId}
                      className="text-[11px] text-rose-400 hover:text-rose-300 flex items-center gap-1 font-medium transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{revokingId === shareId ? 'Revoking...' : 'Revoke'}</span>
                    </button>
                  )}
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
};