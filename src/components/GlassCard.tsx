import React from 'react';

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  glow?: 'blue' | 'cyan' | 'purple' | 'emerald' | 'red' | 'none';
  onClick?: () => void;
  hoverEffect?: boolean;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  className = '',
  glow = 'none',
  onClick,
  hoverEffect = true,
}) => {
  const glowStyles = {
    none: 'border-slate-800/80 shadow-[0_4px_20px_rgba(0,0,0,0.35)]',
    blue: 'border-blue-500/30 shadow-[0_0_24px_rgba(37,99,235,0.12),inset_0_1px_0_rgba(147,197,253,0.12)]',
    cyan: 'border-cyan-500/30 shadow-[0_0_24px_rgba(6,182,212,0.12),inset_0_1px_0_rgba(165,243,252,0.12)]',
    purple: 'border-purple-500/30 shadow-[0_0_24px_rgba(124,58,237,0.12),inset_0_1px_0_rgba(216,180,254,0.12)]',
    emerald: 'border-emerald-500/30 shadow-[0_0_24px_rgba(16,185,129,0.12),inset_0_1px_0_rgba(167,243,208,0.12)]',
    red: 'border-red-500/35 shadow-[0_0_24px_rgba(239,68,68,0.18),inset_0_1px_0_rgba(254,202,202,0.12)]',
  };

  const hoverStyle = hoverEffect
    ? 'hover:border-slate-700/90 hover:shadow-[0_8px_30px_rgba(0,0,0,0.45)] transition-all duration-200'
    : '';

  return (
    <div
      onClick={onClick}
      className={`relative bg-[#0c1322]/85 backdrop-blur-xl border rounded-2xl ${glowStyles[glow]} ${hoverStyle} ${className}`}
    >
      {/* Top subtle highlight shimmer edge */}
      <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent pointer-events-none rounded-t-2xl" />
      {children}
    </div>
  );
};