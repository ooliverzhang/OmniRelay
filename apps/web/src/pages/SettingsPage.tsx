import { useEffect, useRef, useState } from 'react';

import { useSettings, useUpdateSettings } from '../api/hooks';
import type { ReplyPolicyMode, SettingsUpdateRequest, SettingsView } from '../api/types';
import { Button } from '../components/Button';
import { Card, PageHeader } from '../components/Card';
import { ErrorState, LoadingBlock } from '../components/EmptyState';
import { Checkbox, FormField, FormSection, TextArea, TextInput, Toggle } from '../components/Field';
import { Badge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { REPLY_POLICY_MODE_OPTIONS } from '../lib/constants';
import { errorMessage, joinIdList, parseIdList, toInt } from '../lib/format';

interface SettingsForm {
  defaultMode: ReplyPolicyMode;
  allowPrivateWithoutMention: boolean;
  allowGroupWithoutMention: boolean;
  allowChannelWithoutMention: boolean;
  whitelistUserIds: string;
  whitelistGroupIds: string;
  rulesEnabled: boolean;
  stopOnFirstMatch: boolean;
  maxAttempts: string;
  initialDelayMs: string;
  maxDelayMs: string;
}

function fromSettings(view: SettingsView): SettingsForm {
  return {
    defaultMode: view.replyPolicy.defaultMode,
    allowPrivateWithoutMention: view.replyPolicy.allowPrivateWithoutMention,
    allowGroupWithoutMention: view.replyPolicy.allowGroupWithoutMention,
    allowChannelWithoutMention: view.replyPolicy.allowChannelWithoutMention,
    whitelistUserIds: joinIdList(view.replyPolicy.whitelistUserIds),
    whitelistGroupIds: joinIdList(view.replyPolicy.whitelistGroupIds),
    rulesEnabled: view.rules.enabled,
    stopOnFirstMatch: view.rules.stopOnFirstMatch,
    maxAttempts: String(view.retry.maxAttempts),
    initialDelayMs: String(view.retry.initialDelayMs),
    maxDelayMs: String(view.retry.maxDelayMs),
  };
}

export function SettingsPage() {
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const toast = useToast();

  const [form, setForm] = useState<SettingsForm | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    const view = settingsQuery.data;
    if (!view || loadedRef.current) return;
    loadedRef.current = true;
    setForm(fromSettings(view));
  }, [settingsQuery.data]);

  if (settingsQuery.isError) {
    return (
      <>
        <PageHeader title="设置" />
        <div className="surface">
          <ErrorState
            message={errorMessage(settingsQuery.error, '设置加载失败')}
            onRetry={() => {
              void settingsQuery.refetch();
            }}
          />
        </div>
      </>
    );
  }

  const view = settingsQuery.data;
  if (!view || !form) {
    return (
      <>
        <PageHeader title="设置" />
        <LoadingBlock text="正在加载设置…" />
      </>
    );
  }

  const patch = (next: Partial<SettingsForm>) => {
    setForm((previous) => (previous ? { ...previous, ...next } : previous));
  };

  const handleSave = () => {
    const request: SettingsUpdateRequest = {
      replyPolicy: {
        defaultMode: form.defaultMode,
        allowPrivateWithoutMention: form.allowPrivateWithoutMention,
        allowGroupWithoutMention: form.allowGroupWithoutMention,
        allowChannelWithoutMention: form.allowChannelWithoutMention,
        whitelistUserIds: parseIdList(form.whitelistUserIds),
        whitelistGroupIds: parseIdList(form.whitelistGroupIds),
      },
      rules: {
        enabled: form.rulesEnabled,
        defaultAction: 'ignore',
        stopOnFirstMatch: form.stopOnFirstMatch,
      },
      retry: {
        maxAttempts: toInt(form.maxAttempts, view.retry.maxAttempts),
        initialDelayMs: toInt(form.initialDelayMs, view.retry.initialDelayMs),
        maxDelayMs: toInt(form.maxDelayMs, view.retry.maxDelayMs),
      },
    };

    updateSettings.mutate(request, {
      onSuccess: (updated) => {
        setForm(fromSettings(updated));
        toast.success('设置已保存');
      },
      onError: (error) => toast.error(errorMessage(error, '保存设置失败')),
    });
  };

  return (
    <>
      <PageHeader
        title="设置"
        description="全局回复策略、规则引擎与重试参数"
        actions={
          <>
            <Button
              size="sm"
              onClick={() => {
                void settingsQuery.refetch();
              }}
              loading={settingsQuery.isFetching}
            >
              刷新
            </Button>
            <Button size="sm" variant="primary" loading={updateSettings.isPending} onClick={handleSave}>
              保存设置
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title="默认回复策略" description="规则未覆盖时使用的全局行为">
            <div className="space-y-5">
              <FormField label="默认回复模式">
                <div className="grid gap-2 pt-1 sm:grid-cols-2">
                  {REPLY_POLICY_MODE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                        form.defaultMode === option.value
                          ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-100'
                          : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-800/40'
                      }`}
                    >
                      <input
                        type="radio"
                        name="default-mode"
                        value={option.value}
                        checked={form.defaultMode === option.value}
                        onChange={() => patch({ defaultMode: option.value })}
                        className="h-3.5 w-3.5 accent-indigo-500"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </FormField>

              <FormSection title="未 @ 时的行为">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Checkbox
                    label="私聊允许无 @"
                    checked={form.allowPrivateWithoutMention}
                    onChange={(event) => patch({ allowPrivateWithoutMention: event.target.checked })}
                  />
                  <Checkbox
                    label="群聊允许无 @"
                    checked={form.allowGroupWithoutMention}
                    onChange={(event) => patch({ allowGroupWithoutMention: event.target.checked })}
                  />
                  <Checkbox
                    label="频道允许无 @"
                    checked={form.allowChannelWithoutMention}
                    onChange={(event) => patch({ allowChannelWithoutMention: event.target.checked })}
                  />
                </div>
              </FormSection>

              <FormSection title="白名单" description="仅白名单模式或显式白名单校验时生效">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="用户白名单"
                    htmlFor="settings-whitelist-users"
                    hint="一行一个平台用户 ID"
                  >
                    <TextArea
                      id="settings-whitelist-users"
                      rows={4}
                      value={form.whitelistUserIds}
                      onChange={(event) => patch({ whitelistUserIds: event.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="群白名单"
                    htmlFor="settings-whitelist-groups"
                    hint="一行一个群 ID"
                  >
                    <TextArea
                      id="settings-whitelist-groups"
                      rows={4}
                      value={form.whitelistGroupIds}
                      onChange={(event) => patch({ whitelistGroupIds: event.target.value })}
                    />
                  </FormField>
                </div>
              </FormSection>
            </div>
          </Card>

          <Card title="规则引擎">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
                <div>
                  <p className="text-sm text-slate-200">启用规则引擎</p>
                  <p className="text-xs text-slate-500">关闭后所有消息按默认策略处理</p>
                </div>
                <Toggle
                  checked={form.rulesEnabled}
                  label="启用规则引擎"
                  onChange={(next) => patch({ rulesEnabled: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
                <div>
                  <p className="text-sm text-slate-200">命中首条规则后停止</p>
                  <p className="text-xs text-slate-500">关闭时继续评估后续规则</p>
                </div>
                <Toggle
                  checked={form.stopOnFirstMatch}
                  label="命中首条规则后停止"
                  onChange={(next) => patch({ stopOnFirstMatch: next })}
                />
              </div>
            </div>
          </Card>

          <Card title="重试策略" description="发送失败后的指数退避参数">
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="最大尝试次数" htmlFor="settings-max-attempts">
                <TextInput
                  id="settings-max-attempts"
                  type="number"
                  min={1}
                  value={form.maxAttempts}
                  onChange={(event) => patch({ maxAttempts: event.target.value })}
                />
              </FormField>
              <FormField label="初始延迟 (ms)" htmlFor="settings-initial-delay">
                <TextInput
                  id="settings-initial-delay"
                  type="number"
                  min={0}
                  value={form.initialDelayMs}
                  onChange={(event) => patch({ initialDelayMs: event.target.value })}
                />
              </FormField>
              <FormField label="最大延迟 (ms)" htmlFor="settings-max-delay">
                <TextInput
                  id="settings-max-delay"
                  type="number"
                  min={0}
                  value={form.maxDelayMs}
                  onChange={(event) => patch({ maxDelayMs: event.target.value })}
                />
              </FormField>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              当前抖动比例：{view.retry.jitterRatio}（只读）
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="只读信息">
            <dl className="space-y-2.5 text-sm">
              {[
                { label: '版本', value: view.version, mono: true },
                { label: 'Node 版本', value: view.nodeVersion, mono: true },
                { label: '数据目录', value: view.paths.dataDir, mono: true },
                { label: 'SQLite 路径', value: view.paths.sqlitePath, mono: true },
                { label: 'OneBot 路径', value: view.onebot.websocketPath, mono: true },
                { label: '日志级别', value: view.logging.level, mono: false },
                { label: '日志美化输出', value: view.logging.pretty ? '开启' : '关闭', mono: false },
                {
                  label: '面板认证',
                  value: view.web.adminAuth ? '已启用' : '未启用',
                  mono: false,
                },
                {
                  label: '会话有效期',
                  value: `${view.web.sessionTtlSeconds} 秒`,
                  mono: false,
                },
                {
                  label: '动作超时',
                  value: `${view.onebot.actionTimeoutMs} ms`,
                  mono: false,
                },
                {
                  label: '最大待处理动作',
                  value: String(view.onebot.maxPendingActions),
                  mono: false,
                },
              ].map((item) => (
                <div key={item.label} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-xs text-slate-500">{item.label}</dt>
                  <dd
                    className={`min-w-0 break-all text-right text-xs text-slate-300 ${
                      item.mono ? 'font-mono' : ''
                    }`}
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3">
                <dt className="text-xs text-slate-500">OneBot Token</dt>
                <dd>
                  <Badge tone={view.onebot.accessTokenConfigured ? 'success' : 'warning'}>
                    {view.onebot.accessTokenConfigured ? '已配置' : '未配置'}
                  </Badge>
                </dd>
              </div>
            </dl>
          </Card>

          <Card title="提示">
            <p className="text-xs leading-relaxed text-slate-400">
              修改设置会立即写入服务端配置并广播给运行中的模块。凭据类配置只能通过环境变量提供，界面不展示任何密钥值。
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
