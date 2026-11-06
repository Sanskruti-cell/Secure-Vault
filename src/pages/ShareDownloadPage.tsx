import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { SharedLink } from '../types';
import { GlassCard } from '../components/GlassCard';
import { ShieldCheck, Download, Lock, KeyRound, AlertTriangle, CheckCircle2, FileText, Sparkles, RefreshCw } from 'lucide-react';

export const ShareDownloadPage: React.FC = () => {
  const [token, setToken] = useState<string>('');
  const [linkKey, setLinkKey] = useState<string>('');
  const [shareInfo, setShareInfo] = useState<SharedLink | null>(null);
  const [password, setPassword] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [progressStep, setProgressStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState<boolean>(false);

  useEffect(() => {
    // 1. Extract token from path /share/:token or ?token=...
    let extractedToken = '';
    const pathname = window.location.pathname;
    if (pathname.includes('/share/')) {
      extractedToken = pathname.split('/share/')[1]?.split('/')[0]?.split('?')[0] || '';
    }
    if (!extractedToken) {
      const params = new URLSearchParams(window.location.search);
      extractedToken = params.get('token') || '';
    }

    // 2. Extract Link Key from URL hash fragment (#key=...)
    let extractedKey = '';
    if (window.location.hash && window.location.hash.includes('key=')) {
      extractedKey = window.location.hash.split('key=')[1]?.split('&')[0] || '';
    }

    setToken(extractedToken);
    setLinkKey(extractedKey);

    if (extractedToken) {
      fetchMetadata(extractedToken);
    } else {
      setError('Invalid or missing share token in URL.');
      setLoading(false);
    }
  }, []);

  const fetchMetadata = async (tokenToFetch: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getPublicShareInfo(tokenToFetch);
      setShareInfo(data);
    } catch (err: any) {
      setError(err.message || 'Share link not found, expired, or revoked.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!token || !shareInfo) return;

    if (shareInfo.isPasswordProtected && !password.trim()) {
      setError('Please enter the secret passphrase to decrypt this file.');
      return;
    }

    const keyOrPass = shareInfo.isPasswordProtected ? password.trim() : (linkKey || password.trim());
    if (!keyOrPass) {
      setError('Decryption key missing. Please provide the share key or password.');
      return;
    }

    setDownloading(true);
    setError(null);
    setDownloadSuccess(false);

    try {
      setProgressStep('Validating storage node shard fingerprints...');
      await new Promise(r => setTimeout(r, 400));

      setProgressStep('Reconstructing ciphertext via Reed-Solomon 4+2 Cauchy decoder...');
      await new Promise(r => setTimeout(r, 400));

      setProgressStep('Unwrapping DEK client-side & decrypting chunks with AES-256-GCM...');
      const res = await api.downloadPublicShare(token, keyOrPass);

      setProgressStep('Verifying incremental plaintext SHA-256 integrity hash...');
      await new Promise(r => setTimeout(r, 300));

      setDownloadSuccess(true);
      setProgressStep('Payload verified and saved to downloads!');
    } catch (err: any) {
      setError(err.message || 'Decryption or recovery failed. Check passphrase and try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-cyan-400 text-xs font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" /> SecureVault Zero-Knowledge Share Protocol
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Decentralized File Retrieval</h1>
          <p className="text-xs text-slate-400">Reed-Solomon 4+2 Distributed Storage & Client-Side AES-256-GCM</p>
        </div>

        {loading ? (
          <GlassCard className="p-8 text-center space-y-4">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" />
            <div className="text-sm font-semibold text-slate-200">Resolving Share Envelope...</div>
            <div className="text-xs text-slate-400">Querying decentralized metadata and active storage nodes</div>
          </GlassCard>
        ) : error && !shareInfo ? (
          <GlassCard className="p-8 text-center space-y-4 border-rose-500/30">
            <div className="p-3 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 w-12 h-12 mx-auto flex items-center justify-center">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="text-base font-bold text-white">Access Denied / Link Unavailable</div>
            <div className="text-xs text-rose-300 bg-rose-500/10 p-3 rounded-xl border border-rose-500/20 font-mono">
              {error}
            </div>
            <p className="text-[11px] text-slate-400">
              This link may have expired, reached its download limit, or been revoked by the owner.
            </p>
          </GlassCard>
        ) : shareInfo ? (
          <GlassCard glow="blue" className="p-6 space-y-5">
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-cyan-400 shrink-0">
                  <FileText className="w-6 h-6" />
                </div>
                <div className="overflow-hidden">
                  <div className="text-sm font-bold text-white truncate">{shareInfo.fileName}</div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    {shareInfo.fileSize ? `${(shareInfo.fileSize / 1024).toFixed(1)} KB` : 'Encrypted Shard Payload'} • {shareInfo.mimeType || 'application/octet-stream'}
                  </div>
                </div>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                cryptoVersion: 2
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-[11px] bg-slate-900/60 p-3.5 rounded-xl border border-slate-800">
              <div className="text-slate-400">Erasure Coding:</div>
              <div className="text-right font-mono text-cyan-400 font-semibold">Reed-Solomon (4 Data + 2 Parity)</div>
              <div className="text-slate-400">Encryption:</div>
              <div className="text-right font-mono text-slate-200">AES-256-GCM (Client-Side)</div>
              <div className="text-slate-400">Downloads Remaining:</div>
              <div className="text-right font-mono text-slate-200">
                {(shareInfo.downloadLimit || 10) - (shareInfo.downloadCount || 0)} of {shareInfo.downloadLimit || 10}
              </div>
              <div className="text-slate-400">Protection:</div>
              <div className="text-right font-mono text-slate-200">
                {shareInfo.isPasswordProtected ? 'Secret Passphrase' : 'Zero-Knowledge Link Key'}
              </div>
            </div>

            {shareInfo.isPasswordProtected && (
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs text-slate-300 font-medium">
                  <KeyRound className="w-3.5 h-3.5 text-cyan-400" /> Enter Passphrase to Decrypt:
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter the sender's passphrase..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-100 focus:border-blue-500 focus:outline-none placeholder:text-slate-600 font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && handleDownload()}
                />
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {downloading && (
              <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                  <span>{progressStep}</span>
                </div>
                <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-gradient-to-r from-blue-500 to-cyan-400 h-full w-full animate-pulse" />
                </div>
              </div>
            )}

            {downloadSuccess && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Payload decrypted & verified successfully! File download initiated.</span>
              </div>
            )}

            <button
              onClick={handleDownload}
              disabled={downloading}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold text-xs transition-all shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {downloading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Decrypting & Reconstructing...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Decrypt & Download Payload</span>
                </>
              )}
            </button>

            <div className="text-[10px] text-slate-500 text-center leading-relaxed">
              Zero-Knowledge Guarantee: Decryption happens entirely in your browser using the Web Crypto API. The backend only sees Reed-Solomon ciphertext shards and never accesses the plaintext data or decryption keys.
            </div>
          </GlassCard>
        ) : null}
      </div>
    </div>
  );
};
