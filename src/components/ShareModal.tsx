import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { X, Copy, Check, Lock, Share2, ShieldCheck, Clock, Download, KeyRound } from 'lucide-react';

export const ShareModal: React.FC = () => {
  const { isShareOpen, setIsShareOpen, shareTargetFile, createShareLink } = useApp();
  const [password, setPassword] = useState('');
  const [expiresDays, setExpiresDays] = useState(7);
  const [downloadLimit, setDownloadLimit] = useState(10);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!isShareOpen || !shareTargetFile) return null;

  const handleGenerate = async () => {
    setLoading(true);
    const result = await createShareLink(
      shareTargetFile.id,
      password.trim() || undefined,
      expiresDays,
      downloadLimit
    );
    if (result) {
      setShareUrl(result.fullUrl);
    }
    setLoading(false);
  };

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setIsShareOpen(false);
    setShareUrl(null);
    setPassword('');
    setExpiresDays(7);
    setDownloadLimit(10);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d1424] border border-blue-500/40 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl shadow-blue-500/20">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
          <div className="flex items-center gap-2">
            <Share2 className="w-5 h-5 text-blue-400" />
            <span className="font-bold text-slate-100 text-sm">Create Zero-Knowledge Share Link</span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-cyan-400">
                <Lock className="w-5 h-5" />
              </div>
              <div className="overflow-hidden">
                <div className="text-xs font-semibold text-slate-200 truncate">{shareTargetFile.name}</div>
                <div className="text-[10px] text-slate-400 font-mono">
                  {((shareTargetFile.size || 0) / 1024).toFixed(1)} KB • Reed-Solomon 4+2
                </div>
              </div>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              cryptoVersion: 2
            </span>
          </div>

          {!shareUrl ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-1 text-xs text-slate-400 mb-1.5">
                    <Clock className="w-3.5 h-3.5 text-blue-400" /> Link Expiry
                  </label>
                  <select
                    value={expiresDays}
                    onChange={(e) => setExpiresDays(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  >
                    <option value={1}>1 Day</option>
                    <option value={3}>3 Days</option>
                    <option value={7}>7 Days (Default)</option>
                    <option value={30}>30 Days</option>
                  </select>
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs text-slate-400 mb-1.5">
                    <Download className="w-3.5 h-3.5 text-blue-400" /> Max Downloads
                  </label>
                  <select
                    value={downloadLimit}
                    onChange={(e) => setDownloadLimit(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  >
                    <option value={1}>1 (Single Use)</option>
                    <option value={5}>5 Downloads</option>
                    <option value={10}>10 Downloads (Default)</option>
                    <option value={50}>50 Downloads</option>
                    <option value={100}>100 Downloads</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="flex items-center gap-1 text-xs text-slate-400 mb-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-cyan-400" /> Optional Passphrase Protection
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter secret passphrase to protect this share..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  If set, recipient must enter this passphrase to unwrap the encryption key client-side.
                </p>
              </div>

              <div className="p-2.5 rounded-xl bg-blue-500/5 border border-blue-500/20 flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
                <div className="text-[11px] text-slate-300">
                  <span className="font-semibold text-cyan-300">Zero-Knowledge Security:</span> DEK is wrapped client-side in browser before transmission. Plaintext passwords and raw keys are NEVER sent to the backend.
                </div>
              </div>

              <button
                onClick={handleGenerate}
                disabled={loading}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-all shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Deriving Zero-Knowledge Envelope...</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4" />
                    <span>Generate Zero-Knowledge Share Link</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Share link generated! Only someone with this link (and passphrase, if set) can decrypt the file.</span>
              </div>

              <div className="space-y-2">
                <div className="text-xs text-slate-300 font-semibold">Shareable URL:</div>
                <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl p-2.5">
                  <input
                    type="text"
                    readOnly
                    value={shareUrl}
                    className="flex-1 bg-transparent text-xs text-cyan-400 font-mono focus:outline-none truncate"
                  />
                  <button
                    onClick={handleCopy}
                    className="p-2 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-500 flex items-center gap-1.5 shrink-0 font-medium"
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              <div className="text-[11px] text-slate-400 bg-slate-900/60 p-3 rounded-xl border border-slate-800 space-y-1">
                <div className="flex justify-between">
                  <span>Expiration:</span>
                  <span className="font-mono text-slate-200">{expiresDays} Days</span>
                </div>
                <div className="flex justify-between">
                  <span>Download Limit:</span>
                  <span className="font-mono text-slate-200">{downloadLimit} Downloads</span>
                </div>
                <div className="flex justify-between">
                  <span>Passphrase:</span>
                  <span className="font-mono text-slate-200">{password ? 'Enabled (PBKDF2-HMAC-SHA256)' : 'Public URL Fragment Key'}</span>
                </div>
              </div>

              <button
                onClick={handleClose}
                className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};