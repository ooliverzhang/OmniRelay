import type { PlatformCapabilities, PlatformCredentialView } from '../api/types';
import { CAPABILITY_FLAGS, CAPABILITY_LABELS } from '../lib/constants';
import { Badge } from './StatusBadge';

export function CapabilityMatrix({ capabilities }: { capabilities: PlatformCapabilities }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {CAPABILITY_FLAGS.map((flag) => {
        const supported = capabilities[flag];
        return (
          <div
            key={flag}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs ${
              supported ? 'bg-emerald-500/5 text-slate-300' : 'bg-slate-800/30 text-slate-500'
            }`}
          >
            <span className={supported ? 'text-emerald-400' : 'text-slate-600'}>
              {supported ? '✓' : '✗'}
            </span>
            <span className={supported ? '' : 'line-through decoration-slate-700'}>
              {CAPABILITY_LABELS[flag]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CredentialList({ credentials }: { credentials: PlatformCredentialView[] }) {
  if (credentials.length === 0) {
    return <p className="text-xs text-slate-500">该平台无需配置凭据</p>;
  }

  return (
    <div className="space-y-1.5">
      {credentials.map((credential) => (
        <div
          key={credential.env}
          className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <p className="truncate text-xs text-slate-300">{credential.name}</p>
            <p className="truncate font-mono text-[11px] text-slate-500">{credential.env}</p>
          </div>
          <Badge tone={credential.state === 'configured' ? 'success' : 'warning'}>
            {credential.state === 'configured' ? '已配置' : '未配置'}
          </Badge>
        </div>
      ))}
    </div>
  );
}
