import type { PlatformCredentialView } from '../api/types';
import { Badge } from './StatusBadge';

export interface CredentialSummaryProps {
  /** Credentials that are not `configured` yet. */
  pending: PlatformCredentialView[];
  /** Total number of credentials declared by the platform. */
  total: number;
}

/**
 * Compact credential overview used by the platform list.
 *
 * It intentionally renders state only — masked values belong to the detail
 * page and are never shown here.
 */
export function CredentialSummary({ pending, total }: CredentialSummaryProps) {
  if (total === 0) {
    return <p className="text-xs text-slate-500">该平台无需配置凭据</p>;
  }

  if (pending.length === 0) {
    return <p className="text-xs text-slate-400">全部 {total} 项凭据已配置</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400">
        {total - pending.length} / {total} 项已配置
      </p>
      <ul className="space-y-1">
        {pending.map((credential) => (
          <li
            key={credential.env}
            className="flex items-center justify-between gap-2 rounded-md bg-slate-950/40 px-2 py-1"
          >
            <span className="min-w-0">
              <span className="block truncate text-xs text-slate-300">{credential.name}</span>
              <span className="block truncate font-mono text-[11px] text-slate-500">
                {credential.env}
              </span>
            </span>
            <Badge tone={credential.state === 'invalid' ? 'danger' : 'warning'}>
              {credential.state === 'invalid' ? '无效' : '未配置'}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
