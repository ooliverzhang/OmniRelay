import { useCallback, useMemo, useState } from 'react';

import { ApiError } from '../api/client';
import { useDeletePlatformCredential, useSetPlatformCredential } from '../api/hooks';
import type { Platform, PlatformCredentialView } from '../api/types';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { FormField, TextInput } from './Field';
import { Badge } from './StatusBadge';
import { useToast } from './Toast';

/** Fallback shown when the backend returns `masked: null` for a configured key. */
export const MASK_FALLBACK = '••••••••';

/** Message shown next to rows the console is not allowed to write. */
export const READONLY_HINT = '请由运维在服务器 .env 中配置';

const WRITE_DISABLED_CODE = 'credential_write_disabled';

/**
 * Renders the credential rows of a platform and owns the write dialogs.
 *
 * Security notes:
 * - plaintext values live only in this component's `values` state and are wiped
 *   the moment a write succeeds or the dialog closes;
 * - inputs are `type="password"` with `autoComplete="new-password"`;
 * - nothing is written to `localStorage`, `sessionStorage`, the URL or a store,
 *   and no value is ever logged.
 */
export function CredentialEditor({
  platform,
  credentials,
}: {
  platform: Platform;
  credentials: PlatformCredentialView[];
}) {
  const toast = useToast();
  const setCredential = useSetPlatformCredential();
  const deleteCredential = useDeletePlatformCredential();

  const [editing, setEditing] = useState<PlatformCredentialView[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<PlatformCredentialView | null>(null);

  const writableTargets = useMemo(
    () => (editing ?? []).filter((credential) => credential.writable),
    [editing],
  );

  const closeEditor = useCallback(() => {
    setEditing(null);
    setValues({});
    setConfirming(false);
  }, []);

  const openEditor = useCallback((credential: PlatformCredentialView) => {
    setEditing([credential]);
    setValues({});
    setConfirming(false);
  }, []);

  const filledValues = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const credential of writableTargets) {
      const value = values[credential.env];
      if (value === undefined || value.trim() === '') continue;
      entries.push([credential.env, value]);
    }
    return entries;
  }, [values, writableTargets]);

  const hasInput = filledValues.length > 0;

  const submit = () => {
    if (!hasInput) {
      toast.error('请至少填写一个凭据值');
      return;
    }
    setConfirming(true);
  };

  const confirmWrite = () => {
    const payload: Record<string, string> = {};
    for (const [env, value] of filledValues) payload[env] = value;

    setCredential.mutate(
      { platform, values: payload },
      {
        onSuccess: () => {
          // Wipe the plaintext before anything else can read it.
          setValues({});
          setEditing(null);
          setConfirming(false);
          toast.success('凭据已保存');
        },
        onError: (error) => {
          setConfirming(false);
          if (error instanceof ApiError && error.code === WRITE_DISABLED_CODE) {
            toast.error('控制台写入未开启（allow_console_write=false）');
            return;
          }
          toast.error(error.message || '凭据保存失败');
        },
      },
    );
  };

  const confirmRemove = () => {
    const target = removing;
    if (!target) return;
    deleteCredential.mutate(
      { platform, env: target.env },
      {
        onSuccess: () => {
          setRemoving(null);
          toast.success('凭据已清除');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === WRITE_DISABLED_CODE) {
            toast.error('控制台写入未开启（allow_console_write=false）');
            return;
          }
          toast.error(error.message || '清除凭据失败');
        },
      },
    );
  };

  if (credentials.length === 0) {
    return <p className="text-xs text-slate-500">该平台无需配置凭据</p>;
  }

  const confirmEnvs = filledValues.map(([env]) => env);

  return (
    <>
      <ul className="space-y-1.5" aria-label="凭据列表">
        {credentials.map((credential) => {
          const readOnly = !credential.writable;
          return (
            <li
              key={credential.env}
              data-testid={`credential-${credential.env}`}
              className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-xs text-slate-300">{credential.name}</span>
                    <CredentialStateBadge state={credential.state} />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                    {credential.env}
                  </p>
                  {credential.state === 'configured' ? (
                    <p
                      data-testid={`credential-masked-${credential.env}`}
                      className="mt-0.5 truncate font-mono text-[11px] text-slate-400"
                    >
                      {credential.masked ?? MASK_FALLBACK}
                    </p>
                  ) : null}
                  {readOnly ? (
                    <p className="mt-0.5 text-[11px] text-amber-300/80">{READONLY_HINT}</p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {credential.state === 'configured' ? (
                    <Button
                      size="sm"
                      disabled={readOnly}
                      aria-label={`更换 ${credential.name}`}
                      onClick={() => openEditor(credential)}
                    >
                      更换
                    </Button>
                  ) : null}
                  {credential.state === 'missing' ? (
                    <Button
                      size="sm"
                      disabled={readOnly}
                      aria-label={`填写 ${credential.name}`}
                      onClick={() => openEditor(credential)}
                    >
                      填写
                    </Button>
                  ) : null}
                  {credential.state === 'invalid' ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={readOnly}
                      aria-label={`重新填写 ${credential.name}`}
                      onClick={() => openEditor(credential)}
                    >
                      重新填写
                    </Button>
                  ) : null}
                  {credential.state === 'configured' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readOnly}
                      aria-label={`清除 ${credential.name}`}
                      onClick={() => setRemoving(credential)}
                    >
                      清除
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {editing ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
          role="presentation"
          onClick={() => {
            if (!setCredential.isPending) closeEditor();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="配置凭据"
            className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-slate-100">配置凭据</h2>
            <p className="mt-1 text-xs text-slate-500">
              凭据仅提交到服务器 .env，控制台不会保存明文。
            </p>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {editing.map((credential) => (
                <FormField
                  key={credential.env}
                  label={credential.name}
                  hint={credential.env}
                  htmlFor={`credential-input-${credential.env}`}
                >
                  <TextInput
                    id={`credential-input-${credential.env}`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={!credential.writable || setCredential.isPending}
                    placeholder="输入新的凭据值"
                    aria-label={`${credential.name} 值（${credential.env}）`}
                    value={values[credential.env] ?? ''}
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [credential.env]: event.target.value,
                      }))
                    }
                  />
                </FormField>
              ))}

              <div className="flex justify-end gap-2 pt-1">
                <Button onClick={closeEditor} disabled={setCredential.isPending}>
                  取消
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!hasInput || setCredential.isPending}
                >
                  提交
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        dangerous
        loading={setCredential.isPending}
        title="确认写入凭据"
        confirmText="确认写入"
        description={
          <div className="space-y-2">
            <p className="font-mono text-xs text-amber-200">
              确认写入 {confirmEnvs.join('、')} 到 .env？
            </p>
            <p className="text-xs text-slate-400">写入后服务会重新加载该平台连接。</p>
          </div>
        }
        onConfirm={confirmWrite}
        onCancel={() => {
          if (!setCredential.isPending) setConfirming(false);
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        loading={deleteCredential.isPending}
        title="确认清除凭据"
        confirmText="确认清除"
        description={
          <div className="space-y-2">
            {removing ? (
              <p className="font-mono text-xs text-amber-200">确认从 .env 移除 {removing.env}？</p>
            ) : null}
            <p className="text-xs text-slate-400">清除后该平台可能无法继续连接。</p>
          </div>
        }
        onConfirm={confirmRemove}
        onCancel={() => {
          if (!deleteCredential.isPending) setRemoving(null);
        }}
      />
    </>
  );
}

function CredentialStateBadge({ state }: { state: PlatformCredentialView['state'] }) {
  if (state === 'configured') return <Badge tone="success">已配置</Badge>;
  if (state === 'invalid') return <Badge tone="danger">无效</Badge>;
  return <Badge tone="warning">未配置</Badge>;
}
