import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { usePlatform, useUpdatePlatform } from '../api/hooks';
import type { Platform, PlatformUpdateRequest, PlatformView } from '../api/types';
import { Button } from '../components/Button';
import { CapabilityMatrix, CredentialList } from '../components/CapabilityMatrix';
import { Card, PageHeader } from '../components/Card';
import { ErrorState, LoadingBlock } from '../components/EmptyState';
import { Checkbox, FormField, FormSection, TextArea, Toggle } from '../components/Field';
import { Badge, StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { PLATFORM_OPTIONS } from '../lib/constants';
import { errorMessage, formatDateTime, joinIdList, parseIdList } from '../lib/format';

interface FormState {
  enabled: boolean;
  guildAllowlist: string;
  channelAllowlist: string;
  groupAllowlist: string;
  allowProactivePrivate: boolean;
  allowProactiveGroup: boolean;
  receiveAllGroupMessages: boolean;
  messageContentIntent: boolean;
}

function toFormState(view: PlatformView): FormState {
  return {
    enabled: view.enabled,
    guildAllowlist: joinIdList(view.settings.guildAllowlist),
    channelAllowlist: joinIdList(view.settings.channelAllowlist),
    groupAllowlist: joinIdList(view.settings.groupAllowlist),
    allowProactivePrivate: view.settings.allowProactivePrivate,
    allowProactiveGroup: view.settings.allowProactiveGroup,
    receiveAllGroupMessages: view.settings.receiveAllGroupMessages,
    messageContentIntent: view.settings.messageContentIntent,
  };
}

export function PlatformDetailPage() {
  const params = useParams<{ id: string }>();
  const requested = params.id;
  const known = PLATFORM_OPTIONS.some((option) => option.value === requested);
  const platformId = known ? (requested as Platform) : undefined;

  const platformQuery = usePlatform(platformId);
  const updatePlatform = useUpdatePlatform();
  const toast = useToast();

  const [form, setForm] = useState<FormState | null>(null);
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    const view = platformQuery.data;
    if (!view) return;
    if (loadedRef.current === view.platform) return;
    loadedRef.current = view.platform;
    setForm(toFormState(view));
  }, [platformQuery.data]);

  if (!known) {
    return (
      <>
        <PageHeader title="平台配置" />
        <div className="surface">
          <ErrorState message={`不支持的平台标识：${requested ?? '未知'}`} />
          <div className="pb-4 text-center">
            <Link to="/platforms" className="text-xs text-indigo-300 hover:underline">
              返回平台列表
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (platformQuery.isError) {
    return (
      <>
        <PageHeader title="平台配置" />
        <div className="surface">
          <ErrorState
            message={errorMessage(platformQuery.error, '平台配置加载失败')}
            onRetry={() => {
              void platformQuery.refetch();
            }}
          />
        </div>
      </>
    );
  }

  const view = platformQuery.data;
  if (!view || !form) {
    return (
      <>
        <PageHeader title="平台配置" />
        <LoadingBlock text="正在加载平台配置…" />
      </>
    );
  }

  const patch = (next: Partial<FormState>) => {
    setForm((previous) => (previous ? { ...previous, ...next } : previous));
  };

  const handleSave = () => {
    if (!platformId) return;
    const body: PlatformUpdateRequest = {
      enabled: form.enabled,
      settings: {
        guildAllowlist: parseIdList(form.guildAllowlist),
        channelAllowlist: parseIdList(form.channelAllowlist),
        groupAllowlist: parseIdList(form.groupAllowlist),
        allowProactivePrivate: form.allowProactivePrivate,
        allowProactiveGroup: form.allowProactiveGroup,
        receiveAllGroupMessages: form.receiveAllGroupMessages,
        messageContentIntent: form.messageContentIntent,
      },
    };

    updatePlatform.mutate(
      { platform: platformId, body },
      {
        onSuccess: () => toast.success('平台配置已保存'),
        onError: (error) => toast.error(errorMessage(error, '保存平台配置失败')),
      },
    );
  };

  return (
    <>
      <PageHeader
        title={`${view.label} 配置`}
        description={
          <span>
            <Link to="/platforms" className="text-indigo-300 hover:underline">
              平台列表
            </Link>
            <span className="mx-1 text-slate-600">/</span>
            {view.platform}
          </span>
        }
        actions={
          <Button variant="primary" loading={updatePlatform.isPending} onClick={handleSave}>
            保存配置
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title="基础设置" description="启用状态与平台级开关">
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
                <div>
                  <p className="text-sm text-slate-200">启用平台</p>
                  <p className="text-xs text-slate-500">停用后将不再接收或发送该平台的消息</p>
                </div>
                <Toggle
                  checked={form.enabled}
                  label={`${view.label} 启用开关`}
                  onChange={(next) => patch({ enabled: next })}
                />
              </div>

              {platformId === 'discord' ? (
                <FormSection title="Discord 白名单" description="留空表示不限制，一行一个 ID">
                  <FormField
                    label="Guild 白名单"
                    htmlFor="guild-allowlist"
                    hint="Discord 服务器（Guild）ID 列表"
                  >
                    <TextArea
                      id="guild-allowlist"
                      rows={4}
                      placeholder={'123456789012345678\n234567890123456789'}
                      value={form.guildAllowlist}
                      onChange={(event) => patch({ guildAllowlist: event.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="频道白名单"
                    htmlFor="channel-allowlist"
                    hint="Discord 频道（Channel）ID 列表"
                  >
                    <TextArea
                      id="channel-allowlist"
                      rows={4}
                      placeholder={'345678901234567890'}
                      value={form.channelAllowlist}
                      onChange={(event) => patch({ channelAllowlist: event.target.value })}
                    />
                  </FormField>
                  <Checkbox
                    label="启用 Message Content Intent"
                    description="Discord 需要该特权才能读取消息正文"
                    checked={form.messageContentIntent}
                    onChange={(event) => patch({ messageContentIntent: event.target.checked })}
                  />
                </FormSection>
              ) : (
                <FormSection title="QQ 官方机器人设置" description="群白名单与主动消息开关">
                  <FormField
                    label="群白名单"
                    htmlFor="group-allowlist"
                    hint="QQ 群 ID 列表，一行一个"
                  >
                    <TextArea
                      id="group-allowlist"
                      rows={4}
                      placeholder={'123456789\n987654321'}
                      value={form.groupAllowlist}
                      onChange={(event) => patch({ groupAllowlist: event.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="频道白名单"
                    htmlFor="qq-channel-allowlist"
                    hint="QQ 频道 ID 列表（如有）"
                  >
                    <TextArea
                      id="qq-channel-allowlist"
                      rows={3}
                      placeholder={'channel-id-1'}
                      value={form.channelAllowlist}
                      onChange={(event) => patch({ channelAllowlist: event.target.value })}
                    />
                  </FormField>
                  <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                    <Checkbox
                      label="允许主动私聊"
                      description="在收到消息前主动向用户发起私聊"
                      checked={form.allowProactivePrivate}
                      onChange={(event) => patch({ allowProactivePrivate: event.target.checked })}
                    />
                    <Checkbox
                      label="允许主动群聊"
                      description="在收到消息前主动向群聊推送消息"
                      checked={form.allowProactiveGroup}
                      onChange={(event) => patch({ allowProactiveGroup: event.target.checked })}
                    />
                    <Checkbox
                      label="接收全量群消息"
                      description="关闭时仅接收 @ 机器人 的群消息"
                      checked={form.receiveAllGroupMessages}
                      onChange={(event) => patch({ receiveAllGroupMessages: event.target.checked })}
                    />
                  </div>
                </FormSection>
              )}
            </div>
          </Card>

          <Card title="能力矩阵" description="平台不支持的能力会被规则与投递层拒绝">
            <CapabilityMatrix capabilities={view.capabilities} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="运行状态">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">连接状态</dt>
                <dd>
                  <StatusBadge status={view.connection} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">启用状态</dt>
                <dd>
                  <Badge tone={view.enabled ? 'success' : 'neutral'}>
                    {view.enabled ? '已启用' : '已停用'}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">最后事件</dt>
                <dd className="text-right text-xs text-slate-400">
                  {formatDateTime(view.lastEventAt)}
                </dd>
              </div>
              {view.detail ? (
                <div>
                  <dt className="text-slate-500">详情</dt>
                  <dd className="mt-1 break-words text-xs text-slate-400">{view.detail}</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          <Card title="凭据状态" description="仅显示是否配置，不展示任何密钥值">
            <CredentialList credentials={view.credentials} />
          </Card>

          <Card title="提示">
            <p className="text-xs leading-relaxed text-slate-400">
              凭据通过服务器环境变量提供。修改环境变量并重启服务后，此处的状态才会更新。空列表表示不限制白名单。
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
