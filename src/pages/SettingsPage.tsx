import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { GlassCard } from '../components/GlassCard';
import {
  User, Shield, Key, Clock, Lock, Unlock, RefreshCw, AlertTriangle,
  CheckCircle2, Eye, EyeOff, ShieldAlert, ShieldCheck, ChevronRight,
  Database, Cpu, Info
} from 'lucide-react';

/** Password strength */
function passwordStrength(pwd: string) {
  if (!pwd) return { score: 0, label: '', color: '' };
  let score = 0;
  if (pwd.length >= 8) score += 20;
  if (pwd.length >= 12) score += 15;
  if (pwd.length >= 16) score += 10;
  if (/[A-Z]/.test(pwd)) score += 15;
  if (/[a-z]/.test(pwd)) score += 10;
  if (/[0-9]/.test(pwd)) score += 15;
  if (/[^a-zA-Z0-9]/.test(pwd)) score += 15;
  score = Math.min(100, score);
  if (score < 30) return { score, label: 'Weak', color: 'bg-red-500' };
  if (score < 55) return { score, label: 'Fair', color: 'bg-amber-500' };
  if (score < 80) return { score, label: 'Good', color: 'bg-blue-500' };
  return { score, label: 'Strong', color: 'bg-emerald-500' };
}

export const SettingsPage: React.FC = () => {
  const {
    user,
    isVaultLocked,
    lockVault,
    setIsLockModalOpen,
    autoLockMinutes,
    setAutoLockMinutes,
    changeMasterPassword,
    isMasterPasswordSetupRequired,
    showToast,
  } = useApp();

  // ── Change Password form state ─────────────────────────────────────────────
  const [isChangingPass, setIsChangingPass] = useState(false);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeSuccess, setChangeSuccess] = useState(false);
  const [changeLoading, setChangeLoading] = useState(false);

  const strength = passwordStrength(newPass);
  const passMatch = newPass === confirmPass && confirmPass.length > 0;

  const resetChangeForm = () => {
    setCurrentPass(''); setNewPass(''); setConfirmPass('');
    setShowCurrent(false); setShowNew(false);
    setChangeError(null); setChangeSuccess(false);
    setIsChangingPass(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangeError(null);
    setChangeSuccess(false);

    if (!currentPass) { setChangeError('Please enter your current master password.'); return; }
    if (newPass.length < 8) { setChangeError('New master password must be at least 8 characters long.'); return; }
    if (newPass === currentPass) { setChangeError('New password must be different from the current password.'); return; }
    if (newPass !== confirmPass) { setChangeError('New passwords do not match.'); return; }

    setChangeLoading(true);
    try {
      await changeMasterPassword(currentPass, newPass);
      setChangeSuccess(true);
      setTimeout(resetChangeForm, 2500);
    } catch (err: any) {
      setChangeError(err.message || 'Failed to change master password. Check your current password and try again.');
    } finally {
      setChangeLoading(false);
    }
  };

  const inputCls = 'w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';

  // ── Auto-lock options ──────────────────────────────────────────────────────
  const autoLockOptions = [
    { value: 1, label: '1 minute (Strict)' },
    { value: 5, label: '5 minutes' },
    { value: 15, label: '15 minutes (Default)' },
    { value: 30, label: '30 minutes' },
    { value: 60, label: '1 hour' },
    { value: 0, label: 'Never (Not recommended)' },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6 page-enter">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Vault Settings</h1>
        <p className="text-xs text-slate-400 mt-0.5">Cryptographic configuration, master key management, and security preferences</p>
      </div>

      {/* ── Profile & Vault Status ─────────────────────────────────────────── */}
      <GlassCard glow="blue" className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          {/* Avatar */}
          <div className="w-14 h-14 rounded-2xl bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-xl font-bold text-blue-400 shrink-0">
            {user?.name ? user.name.charAt(0).toUpperCase() : <User className="w-6 h-6" />}
          </div>

          {/* User info */}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-white truncate">{user?.name || '—'}</h2>
            <div className="text-xs text-slate-400 font-mono truncate">{user?.email || '—'}</div>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3" /> Authenticated Session
              </span>
              <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${
                isVaultLocked
                  ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                  : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
              }`}>
                {isVaultLocked ? <><Lock className="w-3 h-3" /> Vault Locked</> : <><Unlock className="w-3 h-3" /> Vault Unlocked</>}
              </span>
              {isMasterPasswordSetupRequired && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30 animate-pulse">
                  <ShieldAlert className="w-3 h-3" /> Setup Required
                </span>
              )}
            </div>
          </div>

          {/* Lock / Unlock action */}
          <div className="shrink-0">
            {isMasterPasswordSetupRequired ? (
              <button
                onClick={() => setIsLockModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25 transition-all shadow-lg shadow-amber-500/10"
              >
                <Key className="w-3.5 h-3.5" /> Setup Master Key
              </button>
            ) : isVaultLocked ? (
              <button
                onClick={() => setIsLockModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/20 transition-all"
              >
                <Unlock className="w-3.5 h-3.5" /> Unlock Vault
              </button>
            ) : (
              <button
                onClick={lockVault}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-red-500/15 text-slate-300 hover:text-red-400 border border-slate-700 hover:border-red-500/40 transition-all"
              >
                <Lock className="w-3.5 h-3.5" /> Lock Vault Now
              </button>
            )}
          </div>
        </div>
      </GlassCard>

      {/* ── Master Password & Key Management ──────────────────────────────── */}
      <GlassCard glow="blue" className="p-6 space-y-5">
        <div className="flex items-center gap-2.5 pb-4 border-b border-slate-800">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
            <Key className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <div className="text-xs font-bold text-white">Master Password & Key Management</div>
            <div className="text-[11px] text-slate-400">Client-side zero-knowledge AES-KW key hierarchy — never sent to servers</div>
          </div>
        </div>

        {/* Status cards */}
        {!isChangingPass && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80 space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Master Key Status</div>
              {isMasterPasswordSetupRequired ? (
                <div className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5" /> Not Configured
                </div>
              ) : (
                <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" /> Configured & Active
                </div>
              )}
              <div className="text-[10px] text-slate-500">PBKDF2-HMAC-SHA256 · 100k iterations</div>
            </div>

            <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80 space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Vault Lock State</div>
              <div className={`text-xs font-semibold flex items-center gap-1.5 ${isVaultLocked ? 'text-purple-400' : 'text-cyan-400'}`}>
                {isVaultLocked ? <><Lock className="w-3.5 h-3.5" /> Locked</> : <><Unlock className="w-3.5 h-3.5" /> Unlocked</>}
              </div>
              <div className="text-[10px] text-slate-500">Auto-lock: {autoLockMinutes > 0 ? `${autoLockMinutes} min inactivity` : 'Disabled'}</div>
            </div>

            <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80 space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Key Wrapping Algorithm</div>
              <div className="text-xs font-bold text-cyan-300 font-mono">AES-KW 256-bit</div>
              <div className="text-[10px] text-slate-500">NIST SP 800-38F compliant</div>
            </div>

            <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80 space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Recovery Envelope</div>
              {user?.recoverySalt ? (
                <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Configured
                </div>
              ) : (
                <div className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" /> Not Set
                </div>
              )}
              <div className="text-[10px] text-slate-500">32-byte emergency recovery key</div>
            </div>
          </div>
        )}

        {/* Setup prompt */}
        {isMasterPasswordSetupRequired && !isChangingPass && (
          <div className="p-4 bg-amber-500/8 border border-amber-500/25 rounded-xl space-y-3">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200 leading-relaxed">
                <strong>Master Password not configured.</strong> Without a master password, your vault uses a
                session-derived passkey. Set up a master password to enable vault locking, emergency recovery,
                and portability of your encrypted files across sessions.
              </div>
            </div>
            <button
              onClick={() => setIsLockModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 transition-all"
            >
              <Key className="w-3.5 h-3.5" /> Setup Master Password Now <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Change Password Form */}
        {isChangingPass ? (
          <form onSubmit={handleChangePassword} className="p-4 bg-slate-950/80 rounded-xl border border-blue-500/25 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-white flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-blue-400" />
                Rotate Master Password
              </h4>
              <button
                type="button"
                onClick={resetChangeForm}
                className="text-xs text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              Rotating your master password re-wraps your 256-bit Master Key using AES-KW under a new
              PBKDF2 KEK. File shards and ciphertext blocks are <strong className="text-slate-300">not re-encrypted</strong>.
            </p>

            {changeSuccess && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Master password changed successfully. All keys rewrapped with zero file re-encryption!
              </div>
            )}

            {changeError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{changeError}</span>
              </div>
            )}

            <div className="space-y-3">
              {/* Current password */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1.5">Current Master Password</label>
                <div className="relative">
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    value={currentPass}
                    onChange={(e) => setCurrentPass(e.target.value)}
                    placeholder="Enter current password"
                    className={`${inputCls} pr-10`}
                    required
                    autoFocus
                  />
                  <button type="button" onClick={() => setShowCurrent(!showCurrent)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors">
                    {showCurrent ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* New password */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1.5">New Master Password</label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className={`${inputCls} pr-10`}
                    required
                  />
                  <button type="button" onClick={() => setShowNew(!showNew)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors">
                    {showNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                {newPass.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${strength.color}`} style={{ width: `${strength.score}%` }} />
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-500">
                      <span>Password strength</span>
                      <span className={strength.score < 55 ? 'text-amber-400' : 'text-emerald-400'}>{strength.label}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Confirm new password */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1.5">Confirm New Password</label>
                <input
                  type={showNew ? 'text' : 'password'}
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  placeholder="Re-enter new password"
                  className={`${inputCls} ${
                    confirmPass.length > 0
                      ? passMatch ? 'border-emerald-500/60' : 'border-red-500/50'
                      : ''
                  }`}
                  required
                />
                {confirmPass.length > 0 && !passMatch && (
                  <p className="mt-1 text-[10px] text-red-400">Passwords do not match</p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={resetChangeForm}
                className="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={changeLoading || !currentPass || newPass.length < 8 || !passMatch}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-md shadow-blue-600/20 transition-all"
              >
                {changeLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                {changeLoading ? 'Rewrapping Keys…' : 'Confirm & Rewrap Keys'}
              </button>
            </div>
          </form>
        ) : (
          !isMasterPasswordSetupRequired && (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (isVaultLocked) {
                    setIsLockModalOpen(true);
                    showToast('Unlock your vault first to change the master password.', 'warning');
                  } else {
                    setIsChangingPass(true);
                    setChangeError(null);
                    setChangeSuccess(false);
                  }
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600/15 text-blue-400 border border-blue-500/30 hover:bg-blue-600/25 transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Change Master Password
              </button>
              <button
                onClick={() => setIsLockModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition-all"
              >
                <Shield className="w-3.5 h-3.5" />
                Emergency Recovery
              </button>
            </div>
          )
        )}
      </GlassCard>

      {/* ── Auto-Lock Settings ─────────────────────────────────────────────── */}
      <GlassCard glow="purple" className="p-6 space-y-4">
        <div className="flex items-center gap-2.5 pb-4 border-b border-slate-800">
          <div className="w-8 h-8 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
            <Clock className="w-4 h-4 text-purple-400" />
          </div>
          <div>
            <div className="text-xs font-bold text-white">Inactivity Auto-Lock</div>
            <div className="text-[11px] text-slate-400">Automatically purge decrypted session keys from RAM after inactivity</div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="text-[11px] text-slate-400 leading-relaxed max-w-sm">
            When auto-lock triggers, the master password must be re-entered to perform protected vault
            operations (upload, download, sharing). Session tokens remain valid.
          </div>
          <select
            value={autoLockMinutes}
            onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
            className="bg-slate-950 border border-slate-800 text-xs text-white rounded-xl px-3 py-2 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500/30 transition-all min-w-[180px]"
          >
            {autoLockOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {autoLockMinutes === 0 && (
          <div className="p-3 bg-amber-500/8 border border-amber-500/25 rounded-xl flex items-start gap-2 text-[11px] text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Auto-lock is disabled. Your vault session key stays in memory until you manually lock or log out.</span>
          </div>
        )}
      </GlassCard>

      {/* ── Cryptographic Engine Info ──────────────────────────────────────── */}
      <GlassCard className="p-6 space-y-4">
        <div className="flex items-center gap-2.5 pb-4 border-b border-slate-800">
          <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center">
            <Cpu className="w-4 h-4 text-slate-400" />
          </div>
          <div>
            <div className="text-xs font-bold text-white">Cryptographic Engine</div>
            <div className="text-[11px] text-slate-400">Read-only security configuration</div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { label: 'Cipher Algorithm', value: 'AES-256-GCM', sub: 'Authenticated encryption with additional data' },
            { label: 'Key Derivation', value: 'PBKDF2-HMAC-SHA256', sub: '100,000 iterations · 16-byte random salt per file' },
            { label: 'Key Wrapping', value: 'AES-KW 256-bit', sub: 'NIST SP 800-38F compliant' },
            { label: 'Shard Redundancy', value: 'RS 4+2 (K=4, M=2)', sub: 'Reed-Solomon erasure coding over GF(2^8)' },
            { label: 'IV Construction', value: '8B nonce || 4B counter', sub: 'Unique per-chunk, overflow-protected' },
            { label: 'Integrity Hash', value: 'SHA-256 incremental', sub: 'Computed before encryption, verified after decryption' },
          ].map((item) => (
            <div key={item.label} className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80 space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">{item.label}</div>
              <div className="text-xs font-bold text-cyan-300 font-mono">{item.value}</div>
              <div className="text-[10px] text-slate-500">{item.sub}</div>
            </div>
          ))}
        </div>

        <div className="flex items-start gap-2 p-3 bg-slate-950 rounded-xl border border-slate-800/60 text-[11px] text-slate-400">
          <Database className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-500" />
          <span>
            Encrypted file ciphertexts are sharded using Reed-Solomon 4+2 and distributed across storage nodes.
            Plaintext DEKs and master passwords are never stored on the server — only wrapped key envelopes and KDF salts.
          </span>
        </div>
      </GlassCard>
    </div>
  );
};
