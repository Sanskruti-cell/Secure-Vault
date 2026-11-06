import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, X, Eye, EyeOff, ShieldAlert } from 'lucide-react';

interface SetFilePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (password: string, confirmPassword: string) => void;
  fileName?: string;
}

export const SetFilePasswordModal: React.FC<SetFilePasswordModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  fileName,
}) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password.trim()) {
      setError('Password is required.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    if (!confirmPassword.trim()) {
      setError('Please confirm your password.');
      return;
    }

    if (password !== confirmPassword) {
      setError('File passwords do not match. Please verify your password entry.');
      return;
    }

    onConfirm(password, confirmPassword);
  };

  const handleClose = () => {
    setPassword('');
    setConfirmPassword('');
    setError(null);
    onClose();
  };

  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-white rounded-3xl p-8 shadow-[0_0_50px_rgba(56,189,248,0.45)] border border-sky-400/30 text-slate-900 animate-in zoom-in-95 duration-200">
        {/* Close Button */}
        <button
          type="button"
          onClick={handleClose}
          className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors p-1"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Lock Icon Badge */}
        <div className="w-14 h-14 mx-auto rounded-full bg-sky-100 flex items-center justify-center mb-4 shadow-sm shadow-sky-500/10">
          <Lock className="w-6 h-6 text-sky-500 fill-sky-500" />
        </div>

        {/* Header */}
        <h2 className="text-xl font-bold text-slate-900 text-center tracking-tight mb-1">
          Set File Password
        </h2>
        <p className="text-xs text-slate-500 text-center leading-relaxed max-w-xs mx-auto mb-6">
          Add a password to protect your file. This password will be required to download and recover your file.
        </p>

        {/* Validation Error Banner */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-red-500 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          {/* File Password */}
          <div>
            <label className="text-xs font-semibold text-slate-800 flex items-center gap-1.5 mb-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-700" />
              File Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="Enter password"
                className="w-full bg-slate-100/90 border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 pr-10 transition-all font-sans"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Minimum 8 characters. Use a strong password.
            </p>
          </div>

          {/* Confirm File Password */}
          <div>
            <label className="text-xs font-semibold text-slate-800 flex items-center gap-1.5 mb-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-700" />
              Confirm File Password
            </label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="Re-enter password"
                className="w-full bg-slate-100/90 border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 pr-10 transition-all font-sans"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                tabIndex={-1}
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 py-2.5 px-5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition-colors shadow-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-2.5 px-5 rounded-xl bg-gradient-to-r from-sky-400 to-blue-600 hover:from-sky-500 hover:to-blue-700 text-white font-bold text-xs transition-all shadow-md shadow-sky-500/25"
            >
              Set Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
};
