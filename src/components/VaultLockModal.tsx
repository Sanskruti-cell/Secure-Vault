import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import {
  Lock, Unlock, Key, ShieldCheck, AlertTriangle, Copy, Check,
  Eye, EyeOff, RefreshCw, X, Shield, ChevronRight
} from 'lucide-react';

interface VaultLockModalProps {
  isOpen: boolean;
  onClose?: () => void;
}

type ModalMode = 'unlock' | 'setup' | 'recover';

/** Computes a 0-100 password strength score and label */
function passwordStrength(pwd: string): { score: number; label: string; color: string } {
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

export const VaultLockModal: React.FC<VaultLockModalProps> = ({ isOpen, onClose }) => {
  const {
    user,
    isVaultLocked,
    unlockVault,
    setupMasterPassword,
    recoverMasterPassword,
    isMasterPasswordSetupRequired,
  } = useApp();

  // Determine initial mode from current vault state
  const getInitialMode = useCallback((): ModalMode => {
    if (isMasterPasswordSetupRequired) return 'setup';
    if (isVaultLocked || !user?.hasMasterPassword) return 'unlock';
    return 'unlock';
  }, [isMasterPasswordSetupRequired, isVaultLocked, user]);

  const [mode, setMode] = useState<ModalMode>(getInitialMode);

  // Password / input state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');

  // Setup completion — show recovery key exactly once
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null);
  const [hasCopiedRecovery, setHasCopiedRecovery] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset all form state whenever modal opens
  useEffect(() => {
    if (isOpen) {
      setMode(getInitialMode());
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirm(false);
      setRecoveryKeyInput('');
      setGeneratedRecoveryKey(null);
      setHasCopiedRecovery(false);
      setError(null);
      setLoading(false);
    }
  }, [isOpen, getInitialMode]);

  if (!isOpen) return null;

  // Derived strength
  const strength = passwordStrength(password);
  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError('Please enter your master password.');
      return;
    }
    setLoading(true);
    try {
      const success = await unlockVault(password);
      if (success && onClose) onClose();
    } catch (err: any) {
      setError(err.message || 'Incorrect master password. Access denied.');
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Master password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match. Please re-enter them carefully.');
      return;
    }
    setLoading(true);
    try {
      const recoveryKey = await setupMasterPassword(password);
      setGeneratedRecoveryKey(recoveryKey);
      setPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setError(err.message || 'Failed to initialize master key. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanKey = recoveryKeyInput.trim();
    if (!cleanKey) {
      setError('Please enter your 32-byte emergency recovery key.');
      return;
    }
    // Allow XXXX-XXXX-... format or raw hex
    const hexOnly = cleanKey.replace(/[^a-fA-F0-9]/g, '');
    if (hexOnly.length !== 64) {
      setError('Invalid recovery key format. Paste the full key shown during vault setup.');
      return;
    }
    if (password.length < 8) {
      setError('New master password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const success = await recoverMasterPassword(cleanKey, password);
      if (success && onClose) onClose();
    } catch (err: any) {
      setError(err.message || 'Cryptographic recovery failed. Verify your recovery key is correct.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRecovery = () => {
    if (!generatedRecoveryKey) return;
    navigator.clipboard.writeText(generatedRecoveryKey).catch(() => {});
    setHasCopiedRecovery(true);
    setTimeout(() => setHasCopiedRecovery(false), 3000);
  };

  const handleDownloadRecovery = () => {
    if (!generatedRecoveryKey || !user) return;
    const content = [
      'SecureVault Emergency Recovery Key',
      '===================================',
      '',
      `Account : ${user.email}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'RECOVERY KEY (keep this offline and secure):',
      generatedRecoveryKey,
      '',
      'IMPORTANT:',
      '- This key is shown ONCE. SecureVault uses zero-knowledge encryption.',
      '- Without your master password AND this recovery key your vault CANNOT be recovered.',
      '- Store it in a password manager, printed note, or hardware security device.',
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `securevault-recovery-key-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Allow closing only when vault isn't in a mandatory state
  const canClose = onClose && !isMasterPasswordSetupRequired && !isVaultLocked;

  // ─── Shared Input Styles ──────────────────────────────────────────────────
  const inputCls =
    'w-full bg-slate-950/80 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all';
  const btnPrimary =
    'w-full py-2.5 rounded-xl font-semibold text-xs text-white transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed shadow-lg';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden">
        {/* Header accent line */}
        <div className={`h-1 w-full ${
          mode === 'setup' ? 'bg-gradient-to-r from-blue-600 to-cyan-500' :
          mode === 'recover' ? 'bg-gradient-to-r from-amber-500 to-orange-500' :
          'bg-gradient-to-r from-purple-600 to-blue-600'
        }`} />

        <div className="p-6 space-y-5">

          {/* ── RECOVERY KEY DISPLAY (post-setup) ── */}
          {generatedRecoveryKey ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Vault Initialized!</h3>
                  <p className="text-[11px] text-slate-400">Save your emergency recovery key now</p>
                </div>
              </div>

              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="text-[11px] text-amber-200 leading-relaxed">
                  <strong>This key will only be shown once.</strong> SecureVault uses zero-knowledge
                  cryptography — without your master password <em>or</em> this recovery key, your
                  encrypted files cannot be recovered.
                </div>
              </div>

              <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
                <div className="text-[10px] uppercase font-mono text-slate-400 tracking-widest">
                  Emergency Recovery Key
                </div>
                <div className="font-mono text-[11px] text-cyan-300 break-all select-all font-semibold tracking-wide bg-slate-900/80 p-3 rounded-lg border border-slate-800/80 leading-relaxed">
                  {generatedRecoveryKey}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleCopyRecovery}
                  className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition-all"
                >
                  {hasCopiedRecovery ? (
                    <><Check className="w-4 h-4 text-emerald-400" /> Copied!</>
                  ) : (
                    <><Copy className="w-4 h-4" /> Copy Key</>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadRecovery}
                  className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition-all"
                >
                  <Shield className="w-4 h-4 text-cyan-400" />
                  Download .txt
                </button>
              </div>

              <button
                type="button"
                onClick={() => { setGeneratedRecoveryKey(null); if (onClose) onClose(); }}
                className={`${btnPrimary} bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 shadow-emerald-500/20`}
              >
                <ShieldCheck className="w-4 h-4" />
                I've Saved My Recovery Key — Continue
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

          ) : mode === 'setup' ? (
            /* ── SETUP FORM ── */
            <form onSubmit={handleSetup} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center shrink-0">
                  <Key className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Initialize Master Password</h3>
                  <p className="text-[11px] text-slate-400">Zero-knowledge AES-KW vault key — never sent to servers</p>
                </div>
              </div>

              <div className="p-3 bg-blue-500/8 border border-blue-500/20 rounded-xl text-[11px] text-blue-200 leading-relaxed">
                Your master password derives a 256-bit Key Encryption Key (KEK) via
                PBKDF2-HMAC-SHA256 (100,000 iterations). It encrypts your vault's Master Key
                client-side — SecureVault's servers only store a cryptographic wrapped key, never the plaintext.
              </div>

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-3">
                {/* Password */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Master Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      className={`${inputCls} pr-10`}
                      autoFocus
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  {/* Password strength bar */}
                  {password.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${strength.color}`}
                          style={{ width: `${strength.score}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-500">
                        <span>Strength</span>
                        <span className={
                          strength.score < 30 ? 'text-red-400' :
                          strength.score < 55 ? 'text-amber-400' :
                          strength.score < 80 ? 'text-blue-400' : 'text-emerald-400'
                        }>{strength.label}</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Confirm */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Confirm Master Password</label>
                  <div className="relative">
                    <input
                      type={showConfirm ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter master password"
                      className={`${inputCls} pr-10 ${
                        confirmPassword.length > 0
                          ? passwordsMatch
                            ? 'border-emerald-500/60 focus:border-emerald-500'
                            : 'border-red-500/50 focus:border-red-500'
                          : ''
                      }`}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors"
                    >
                      {showConfirm ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  {confirmPassword.length > 0 && !passwordsMatch && (
                    <p className="mt-1 text-[10px] text-red-400">Passwords do not match</p>
                  )}
                  {confirmPassword.length > 0 && passwordsMatch && (
                    <p className="mt-1 text-[10px] text-emerald-400 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Passwords match
                    </p>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || password.length < 8 || !passwordsMatch}
                className={`${btnPrimary} bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 shadow-blue-500/20`}
              >
                {loading ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Deriving Keys & Building Envelope…</>
                ) : (
                  <><ShieldCheck className="w-4 h-4" /> Initialize Master Key</>
                )}
              </button>
            </form>

          ) : mode === 'recover' ? (
            /* ── RECOVERY FORM ── */
            <form onSubmit={handleRecover} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
                  <RefreshCw className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Emergency Recovery</h3>
                  <p className="text-[11px] text-slate-400">Reset master password using your 32-byte recovery key</p>
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Emergency Recovery Key
                  </label>
                  <textarea
                    rows={2}
                    value={recoveryKeyInput}
                    onChange={(e) => setRecoveryKeyInput(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                    className="w-full font-mono bg-slate-950/80 border border-slate-800 rounded-xl px-3 py-2.5 text-[11px] text-cyan-300 placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-all resize-none uppercase"
                    required
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    The 64-character hex key shown at vault setup (with or without dashes)
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">New Master Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      className={`${inputCls} pr-10`}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  {password.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${strength.color}`} style={{ width: `${strength.score}%` }} />
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Confirm New Password</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className={`${inputCls} ${
                      confirmPassword.length > 0
                        ? passwordsMatch ? 'border-emerald-500/60' : 'border-red-500/50'
                        : ''
                    }`}
                    required
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setMode('unlock'); setError(null); setPassword(''); setConfirmPassword(''); setRecoveryKeyInput(''); }}
                  className="py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-all"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  disabled={loading || password.length < 8 || !passwordsMatch}
                  className={`${btnPrimary} flex-1 bg-gradient-to-r from-amber-600 to-orange-500 hover:from-amber-500 hover:to-orange-400 shadow-amber-500/20`}
                >
                  {loading ? (
                    <><RefreshCw className="w-4 h-4 animate-spin" /> Restoring Vault Key…</>
                  ) : (
                    <><Unlock className="w-4 h-4" /> Restore Access & Reset Password</>
                  )}
                </button>
              </div>
            </form>

          ) : (
            /* ── UNLOCK FORM ── */
            <form onSubmit={handleUnlock} className="space-y-4">
              {canClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="absolute top-5 right-5 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800/60 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 flex items-center justify-center shrink-0">
                  <Lock className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Vault Locked</h3>
                  <p className="text-[11px] text-slate-400">
                    {user?.email ? `Unlock vault for ${user.email}` : 'Enter master password to unlock'}
                  </p>
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Master Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your master password"
                    className={`${inputCls} pr-10`}
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !password}
                className={`${btnPrimary} bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 shadow-purple-500/20`}
              >
                {loading ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Verifying & Unwrapping Master Key…</>
                ) : (
                  <><Unlock className="w-4 h-4" /> Unlock Vault</>
                )}
              </button>

              {/* Only show forgot if master password is actually configured */}
              {user?.hasMasterPassword && user.recoverySalt && (
                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => { setMode('recover'); setError(null); setPassword(''); }}
                    className="text-[11px] text-slate-400 hover:text-amber-400 transition-colors"
                  >
                    Forgot master password? Use emergency recovery key →
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
