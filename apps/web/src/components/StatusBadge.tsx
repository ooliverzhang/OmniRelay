import type { ReactNode } from 'react';

import type { ConnectionState } from '../api/types';
import { connectionLabel, connectionTone, type BadgeTone } from '../lib/constants';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'border-slate-700 bg-slate-800/60 text-slate-300',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  danger: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  info: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-400',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-rose-400',
  info: 'bg-indigo-400',
};

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = false, className = '', children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {dot ? (
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}

export interface StatusBadgeProps {
  status: ConnectionState | string;
  /** Overrides the default Chinese label. */
  label?: string;
  dot?: boolean;
}

export function StatusBadge({ status, label, dot = true }: StatusBadgeProps) {
  return (
    <Badge tone={connectionTone(status)} dot={dot}>
      {label ?? connectionLabel(status)}
    </Badge>
  );
}
