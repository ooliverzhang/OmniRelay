import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useCreateRule, useRule, useUpdateRule } from '../api/hooks';
import type {
  ConversationKind,
  MessageKind,
  Platform,
  RateLimitScope,
  RuleUpsertRequest,
  RuleView,
  ResponsePolicy,
  ScheduleConfig,
  TriggerConfig,
} from '../api/types';
import { Button } from '../components/Button';
import { Card, PageHeader } from '../components/Card';
import { ErrorState, LoadingBlock } from '../components/EmptyState';
import { Checkbox, FormField, FormSection, Select, TextArea, TextInput, Toggle } from '../components/Field';
import { useToast } from '../components/Toast';
import {
  CONVERSATION_KIND_OPTIONS,
  MESSAGE_KIND_OPTIONS,
  PLATFORM_OPTIONS,
  RATE_LIMIT_SCOPE_OPTIONS,
  WEEKDAY_OPTIONS,
} from '../lib/constants';
import {
  errorMessage,
  formatDateTime,
  joinIdList,
  parseIdList,
  parseLineList,
  toInt,
} from '../lib/format';

interface TriggerForm {
  requireMention: boolean;
  requireReplyToBot: boolean;
  textIncludes: string;
  textPrefix: string;
  textRegex: string;
  messageTypes: MessageKind[];
  userAllowlist: string;
  groupAllowlist: string;
  channelAllowlist: string;
  privateOnly: boolean;
  groupOnly: boolean;
  ignoreBots: boolean;
}

interface ResponseForm {
  enabled: boolean;
  allowProactive: boolean;
  allowPrivate: boolean;
  allowGroup: boolean;
  allowChannel: boolean;
  maxResponseSegments: string;
}

interface RateLimitForm {
  enabled: boolean;
  maxMessages: string;
  windowSeconds: string;
  scope: RateLimitScope;
}

interface ScheduleForm {
  enabled: boolean;
  timezone: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
}

interface EditorState {
  name: string;
  enabled: boolean;
  priority: string;
  platforms: Platform[];
  conversationKinds: ConversationKind[];
  groupIds: string;
  channelIds: string;
  userIds: string;
  trigger: TriggerForm;
  response: ResponseForm;
  rateLimit: RateLimitForm;
  schedule: ScheduleForm;
}

function emptyState(): EditorState {
  return {
    name: '',
    enabled: true,
    priority: '100',
    platforms: ['discord', 'qq-official'],
    conversationKinds: ['private', 'group'],
    groupIds: '',
    channelIds: '',
    userIds: '',
    trigger: {
      requireMention: false,
      requireReplyToBot: false,
      textIncludes: '',
      textPrefix: '',
      textRegex: '',
      messageTypes: [],
      userAllowlist: '',
      groupAllowlist: '',
      channelAllowlist: '',
      privateOnly: false,
      groupOnly: false,
      ignoreBots: true,
    },
    response: {
      enabled: true,
      allowProactive: false,
      allowPrivate: true,
      allowGroup: true,
      allowChannel: true,
      maxResponseSegments: '',
    },
    rateLimit: { enabled: false, maxMessages: '10', windowSeconds: '60', scope: 'user' },
    schedule: {
      enabled: false,
      timezone: 'Asia/Shanghai',
      weekdays: [],
      startTime: '09:00',
      endTime: '22:00',
    },
  };
}

function fromRule(rule: RuleView): EditorState {
  const trigger = rule.trigger;
  const response = rule.response;
  return {
    name: rule.name,
    enabled: rule.enabled,
    priority: String(rule.priority),
    platforms: [...rule.platforms],
    conversationKinds: [...rule.conversationKinds],
    groupIds: joinIdList(rule.groupIds),
    channelIds: joinIdList(rule.channelIds),
    userIds: joinIdList(rule.userIds),
    trigger: {
      requireMention: trigger.requireMention ?? false,
      requireReplyToBot: trigger.requireReplyToBot ?? false,
      textIncludes: joinIdList(trigger.textIncludes),
      textPrefix: trigger.textPrefix ?? '',
      textRegex: trigger.textRegex ?? '',
      messageTypes: trigger.messageTypes ? [...trigger.messageTypes] : [],
      userAllowlist: joinIdList(trigger.userAllowlist),
      groupAllowlist: joinIdList(trigger.groupAllowlist),
      channelAllowlist: joinIdList(trigger.channelAllowlist),
      privateOnly: trigger.privateOnly ?? false,
      groupOnly: trigger.groupOnly ?? false,
      ignoreBots: trigger.ignoreBots ?? true,
    },
    response: {
      enabled: response.enabled,
      allowProactive: response.allowProactive,
      allowPrivate: response.allowPrivate,
      allowGroup: response.allowGroup,
      allowChannel: response.allowChannel,
      maxResponseSegments:
        typeof response.maxResponseSegments === 'number' ? String(response.maxResponseSegments) : '',
    },
    rateLimit: rule.rateLimit
      ? {
          enabled: true,
          maxMessages: String(rule.rateLimit.maxMessages),
          windowSeconds: String(rule.rateLimit.windowSeconds),
          scope: rule.rateLimit.scope,
        }
      : { enabled: false, maxMessages: '10', windowSeconds: '60', scope: 'user' },
    schedule: rule.schedule
      ? {
          enabled: true,
          timezone: rule.schedule.timezone ?? '',
          weekdays: rule.schedule.weekdays ? [...rule.schedule.weekdays] : [],
          startTime: rule.schedule.startTime ?? '',
          endTime: rule.schedule.endTime ?? '',
        }
      : {
          enabled: false,
          timezone: 'Asia/Shanghai',
          weekdays: [],
          startTime: '09:00',
          endTime: '22:00',
        },
  };
}

function toggleItem<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function toPayload(state: EditorState): RuleUpsertRequest {
  const trigger: TriggerConfig = { ignoreBots: state.trigger.ignoreBots };
  if (state.trigger.requireMention) trigger.requireMention = true;
  if (state.trigger.requireReplyToBot) trigger.requireReplyToBot = true;
  if (state.trigger.privateOnly) trigger.privateOnly = true;
  if (state.trigger.groupOnly) trigger.groupOnly = true;

  const textIncludes = parseLineList(state.trigger.textIncludes);
  if (textIncludes.length > 0) trigger.textIncludes = textIncludes;
  if (state.trigger.textPrefix.trim()) trigger.textPrefix = state.trigger.textPrefix.trim();
  if (state.trigger.textRegex.trim()) trigger.textRegex = state.trigger.textRegex.trim();
  if (state.trigger.messageTypes.length > 0) trigger.messageTypes = [...state.trigger.messageTypes];

  const userAllowlist = parseIdList(state.trigger.userAllowlist);
  if (userAllowlist.length > 0) trigger.userAllowlist = userAllowlist;
  const groupAllowlist = parseIdList(state.trigger.groupAllowlist);
  if (groupAllowlist.length > 0) trigger.groupAllowlist = groupAllowlist;
  const channelAllowlist = parseIdList(state.trigger.channelAllowlist);
  if (channelAllowlist.length > 0) trigger.channelAllowlist = channelAllowlist;

  const response: ResponsePolicy = {
    enabled: state.response.enabled,
    allowProactive: state.response.allowProactive,
    allowPrivate: state.response.allowPrivate,
    allowGroup: state.response.allowGroup,
    allowChannel: state.response.allowChannel,
  };

  const maxSegments = Number.parseInt(state.response.maxResponseSegments, 10);
  if (Number.isFinite(maxSegments) && maxSegments > 0) {
    response.maxResponseSegments = maxSegments;
  }

  const payload: RuleUpsertRequest = {
    name: state.name.trim(),
    enabled: state.enabled,
    priority: toInt(state.priority, 100),
    platforms: [...state.platforms],
    conversationKinds: [...state.conversationKinds],
    groupIds: parseIdList(state.groupIds),
    channelIds: parseIdList(state.channelIds),
    userIds: parseIdList(state.userIds),
    trigger,
    response,
  };

  if (state.rateLimit.enabled) {
    const maxMessages = Number.parseInt(state.rateLimit.maxMessages, 10);
    const windowSeconds = Number.parseInt(state.rateLimit.windowSeconds, 10);
    if (Number.isFinite(maxMessages) && maxMessages > 0 && Number.isFinite(windowSeconds) && windowSeconds > 0) {
      payload.rateLimit = { maxMessages, windowSeconds, scope: state.rateLimit.scope };
    }
  }

  if (state.schedule.enabled) {
    const schedule: ScheduleConfig = {};
    if (state.schedule.timezone.trim()) schedule.timezone = state.schedule.timezone.trim();
    if (state.schedule.weekdays.length > 0) {
      schedule.weekdays = [...state.schedule.weekdays].sort((a, b) => a - b);
    }
    if (state.schedule.startTime) schedule.startTime = state.schedule.startTime;
    if (state.schedule.endTime) schedule.endTime = state.schedule.endTime;
    payload.schedule = schedule;
  }

  return payload;
}

export function RuleEditorPage() {
  const params = useParams<{ id: string }>();
  const isEdit = Boolean(params.id);
  const ruleQuery = useRule(params.id);
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const navigate = useNavigate();
  const toast = useToast();

  const [state, setState] = useState<EditorState | null>(() => (isEdit ? null : emptyState()));
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    const rule = ruleQuery.data;
    if (!rule) return;
    if (loadedRef.current === rule.id) return;
    loadedRef.current = rule.id;
    setState(fromRule(rule));
  }, [ruleQuery.data]);

  if (isEdit && ruleQuery.isError) {
    return (
      <>
        <PageHeader title="编辑规则" />
        <div className="surface">
          <ErrorState
            message={errorMessage(ruleQuery.error, '规则加载失败')}
            onRetry={() => {
              void ruleQuery.refetch();
            }}
          />
        </div>
      </>
    );
  }

  if (!state) {
    return (
      <>
        <PageHeader title="编辑规则" />
        <LoadingBlock text="正在加载规则…" />
      </>
    );
  }

  const patch = (next: Partial<EditorState>) => {
    setState((previous) => (previous ? { ...previous, ...next } : previous));
  };

  const patchTrigger = (next: Partial<TriggerForm>) => {
    setState((previous) =>
      previous ? { ...previous, trigger: { ...previous.trigger, ...next } } : previous,
    );
  };

  const patchResponse = (next: Partial<ResponseForm>) => {
    setState((previous) =>
      previous ? { ...previous, response: { ...previous.response, ...next } } : previous,
    );
  };

  const patchRateLimit = (next: Partial<RateLimitForm>) => {
    setState((previous) =>
      previous ? { ...previous, rateLimit: { ...previous.rateLimit, ...next } } : previous,
    );
  };

  const patchSchedule = (next: Partial<ScheduleForm>) => {
    setState((previous) =>
      previous ? { ...previous, schedule: { ...previous.schedule, ...next } } : previous,
    );
  };

  const saving = createRule.isPending || updateRule.isPending;

  const handleSubmit = () => {
    if (!state.name.trim()) {
      toast.error('请填写规则名称');
      return;
    }
    if (state.platforms.length === 0) {
      toast.error('请至少选择一个平台');
      return;
    }
    if (state.conversationKinds.length === 0) {
      toast.error('请至少选择一种会话类型');
      return;
    }

    const payload = toPayload(state);

    if (isEdit && params.id) {
      updateRule.mutate(
        { id: params.id, body: payload },
        {
          onSuccess: (rule) => {
            toast.success(`规则「${rule.name}」已保存`);
            navigate('/rules');
          },
          onError: (error) => toast.error(errorMessage(error, '保存规则失败')),
        },
      );
      return;
    }

    createRule.mutate(payload, {
      onSuccess: (rule) => {
        toast.success(`规则「${rule.name}」已创建`);
        navigate('/rules');
      },
      onError: (error) => toast.error(errorMessage(error, '创建规则失败')),
    });
  };

  const ruleMeta = isEdit && ruleQuery.data ? ruleQuery.data : null;

  return (
    <>
      <PageHeader
        title={isEdit ? '编辑规则' : '新建规则'}
        description={
          ruleMeta
            ? `创建于 ${formatDateTime(ruleMeta.createdAt)} · 更新于 ${formatDateTime(ruleMeta.updatedAt)}`
            : '配置消息匹配条件与回复策略'
        }
        actions={
          <>
            <Link
              to="/rules"
              className="inline-flex h-8 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 text-xs text-slate-200 hover:bg-slate-800"
            >
              返回列表
            </Link>
            <Button variant="primary" loading={saving} onClick={handleSubmit}>
              保存规则
            </Button>
          </>
        }
      />

      <div className="space-y-4">
        <Card title="基本信息">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="规则名称" htmlFor="rule-name" required>
                <TextInput
                  id="rule-name"
                  value={state.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="如：Discord 求助频道自动回复"
                />
              </FormField>

              <FormField label="优先级" htmlFor="rule-priority" hint="数值越小越先评估">
                <TextInput
                  id="rule-priority"
                  type="number"
                  min={0}
                  value={state.priority}
                  onChange={(event) => patch({ priority: event.target.value })}
                />
              </FormField>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-200">启用规则</p>
                <p className="text-xs text-slate-500">停用后该规则不会参与评估</p>
              </div>
              <Toggle
                checked={state.enabled}
                label="启用规则"
                onChange={(next) => patch({ enabled: next })}
              />
            </div>

            <FormField label="适用平台" required>
              <div className="flex flex-wrap gap-4 pt-1">
                {PLATFORM_OPTIONS.map((option) => (
                  <Checkbox
                    key={option.value}
                    label={option.label}
                    checked={state.platforms.includes(option.value)}
                    onChange={() => patch({ platforms: toggleItem(state.platforms, option.value) })}
                  />
                ))}
              </div>
            </FormField>

            <FormField label="会话类型" required>
              <div className="flex flex-wrap gap-4 pt-1">
                {CONVERSATION_KIND_OPTIONS.map((option) => (
                  <Checkbox
                    key={option.value}
                    label={option.label}
                    checked={state.conversationKinds.includes(option.value)}
                    onChange={() =>
                      patch({ conversationKinds: toggleItem(state.conversationKinds, option.value) })
                    }
                  />
                ))}
              </div>
            </FormField>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="群 ID 列表" htmlFor="rule-group-ids" hint="逗号或换行分隔">
                <TextArea
                  id="rule-group-ids"
                  rows={3}
                  value={state.groupIds}
                  onChange={(event) => patch({ groupIds: event.target.value })}
                  placeholder="123456789"
                />
              </FormField>
              <FormField label="频道 ID 列表" htmlFor="rule-channel-ids" hint="逗号或换行分隔">
                <TextArea
                  id="rule-channel-ids"
                  rows={3}
                  value={state.channelIds}
                  onChange={(event) => patch({ channelIds: event.target.value })}
                  placeholder="987654321"
                />
              </FormField>
              <FormField label="用户 ID 列表" htmlFor="rule-user-ids" hint="逗号或换行分隔">
                <TextArea
                  id="rule-user-ids"
                  rows={3}
                  value={state.userIds}
                  onChange={(event) => patch({ userIds: event.target.value })}
                  placeholder="555555555"
                />
              </FormField>
            </div>
          </div>
        </Card>

        <Card title="触发条件">
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Checkbox
                label="必须 @ 机器人"
                checked={state.trigger.requireMention}
                onChange={(event) => patchTrigger({ requireMention: event.target.checked })}
              />
              <Checkbox
                label="必须回复机器人消息"
                checked={state.trigger.requireReplyToBot}
                onChange={(event) => patchTrigger({ requireReplyToBot: event.target.checked })}
              />
              <Checkbox
                label="仅私聊"
                checked={state.trigger.privateOnly}
                onChange={(event) => patchTrigger({ privateOnly: event.target.checked })}
              />
              <Checkbox
                label="仅群聊"
                checked={state.trigger.groupOnly}
                onChange={(event) => patchTrigger({ groupOnly: event.target.checked })}
              />
              <Checkbox
                label="忽略其他机器人"
                description="默认开启"
                checked={state.trigger.ignoreBots}
                onChange={(event) => patchTrigger({ ignoreBots: event.target.checked })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="文本前缀" htmlFor="rule-text-prefix" hint="消息需以该字符串开头">
                <TextInput
                  id="rule-text-prefix"
                  value={state.trigger.textPrefix}
                  onChange={(event) => patchTrigger({ textPrefix: event.target.value })}
                  placeholder="如 !help"
                />
              </FormField>
              <FormField label="文本正则" htmlFor="rule-text-regex" hint="JavaScript 正则表达式">
                <TextInput
                  id="rule-text-regex"
                  value={state.trigger.textRegex}
                  onChange={(event) => patchTrigger({ textRegex: event.target.value })}
                  placeholder="如 ^\\d{4}$"
                />
              </FormField>
            </div>

            <FormField label="包含关键词" htmlFor="rule-text-includes" hint="每行一个关键词，命中任意一个即匹配">
              <TextArea
                id="rule-text-includes"
                rows={3}
                value={state.trigger.textIncludes}
                onChange={(event) => patchTrigger({ textIncludes: event.target.value })}
                placeholder={'帮助\n怎么用'}
              />
            </FormField>

            <FormField label="消息类型">
              <div className="flex flex-wrap gap-4 pt-1">
                {MESSAGE_KIND_OPTIONS.map((option) => (
                  <Checkbox
                    key={option.value}
                    label={option.label}
                    checked={state.trigger.messageTypes.includes(option.value)}
                    onChange={() =>
                      patchTrigger({ messageTypes: toggleItem(state.trigger.messageTypes, option.value) })
                    }
                  />
                ))}
              </div>
            </FormField>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="用户允许列表" htmlFor="rule-user-allowlist" hint="留空表示不限制">
                <TextArea
                  id="rule-user-allowlist"
                  rows={3}
                  value={state.trigger.userAllowlist}
                  onChange={(event) => patchTrigger({ userAllowlist: event.target.value })}
                />
              </FormField>
              <FormField label="群允许列表" htmlFor="rule-group-allowlist" hint="留空表示不限制">
                <TextArea
                  id="rule-group-allowlist"
                  rows={3}
                  value={state.trigger.groupAllowlist}
                  onChange={(event) => patchTrigger({ groupAllowlist: event.target.value })}
                />
              </FormField>
              <FormField label="频道允许列表" htmlFor="rule-channel-allowlist" hint="留空表示不限制">
                <TextArea
                  id="rule-channel-allowlist"
                  rows={3}
                  value={state.trigger.channelAllowlist}
                  onChange={(event) => patchTrigger({ channelAllowlist: event.target.value })}
                />
              </FormField>
            </div>
          </div>
        </Card>

        <Card title="响应策略">
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-200">允许自动回复</p>
                <p className="text-xs text-slate-500">关闭后该规则只做匹配，不发送任何消息</p>
              </div>
              <Toggle
                checked={state.response.enabled}
                label="允许自动回复"
                onChange={(next) => patchResponse({ enabled: next })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Checkbox
                label="允许主动消息"
                checked={state.response.allowProactive}
                onChange={(event) => patchResponse({ allowProactive: event.target.checked })}
              />
              <Checkbox
                label="允许私聊"
                checked={state.response.allowPrivate}
                onChange={(event) => patchResponse({ allowPrivate: event.target.checked })}
              />
              <Checkbox
                label="允许群聊"
                checked={state.response.allowGroup}
                onChange={(event) => patchResponse({ allowGroup: event.target.checked })}
              />
              <Checkbox
                label="允许频道"
                checked={state.response.allowChannel}
                onChange={(event) => patchResponse({ allowChannel: event.target.checked })}
              />
            </div>

            <FormField
              label="最大响应分段数"
              htmlFor="rule-max-segments"
              hint="留空表示不限制；超过预算的请求会被拒绝"
            >
              <TextInput
                id="rule-max-segments"
                type="number"
                min={1}
                value={state.response.maxResponseSegments}
                onChange={(event) => patchResponse({ maxResponseSegments: event.target.value })}
                placeholder="如 5"
              />
            </FormField>
          </div>
        </Card>

        <Card title="限流与时间计划" description="两者均可留空，留空表示不启用">
          <div className="space-y-5">
            <FormSection title="限流">
              <Checkbox
                label="启用限流"
                checked={state.rateLimit.enabled}
                onChange={(event) => patchRateLimit({ enabled: event.target.checked })}
              />
              {state.rateLimit.enabled ? (
                <div className="grid gap-4 sm:grid-cols-3">
                  <FormField label="窗口内最大条数" htmlFor="rule-rate-max">
                    <TextInput
                      id="rule-rate-max"
                      type="number"
                      min={1}
                      value={state.rateLimit.maxMessages}
                      onChange={(event) => patchRateLimit({ maxMessages: event.target.value })}
                    />
                  </FormField>
                  <FormField label="窗口秒数" htmlFor="rule-rate-window">
                    <TextInput
                      id="rule-rate-window"
                      type="number"
                      min={1}
                      value={state.rateLimit.windowSeconds}
                      onChange={(event) => patchRateLimit({ windowSeconds: event.target.value })}
                    />
                  </FormField>
                  <FormField label="限流维度" htmlFor="rule-rate-scope">
                    <Select
                      id="rule-rate-scope"
                      value={state.rateLimit.scope}
                      onChange={(event) =>
                        patchRateLimit({ scope: event.target.value as RateLimitScope })
                      }
                    >
                      {RATE_LIMIT_SCOPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                </div>
              ) : null}
            </FormSection>

            <FormSection title="时间计划">
              <Checkbox
                label="启用时间计划"
                checked={state.schedule.enabled}
                onChange={(event) => patchSchedule({ enabled: event.target.checked })}
              />
              {state.schedule.enabled ? (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <FormField label="时区" htmlFor="rule-schedule-timezone">
                      <TextInput
                        id="rule-schedule-timezone"
                        value={state.schedule.timezone}
                        onChange={(event) => patchSchedule({ timezone: event.target.value })}
                        placeholder="Asia/Shanghai"
                      />
                    </FormField>
                    <FormField label="开始时间" htmlFor="rule-schedule-start">
                      <TextInput
                        id="rule-schedule-start"
                        type="time"
                        value={state.schedule.startTime}
                        onChange={(event) => patchSchedule({ startTime: event.target.value })}
                      />
                    </FormField>
                    <FormField label="结束时间" htmlFor="rule-schedule-end">
                      <TextInput
                        id="rule-schedule-end"
                        type="time"
                        value={state.schedule.endTime}
                        onChange={(event) => patchSchedule({ endTime: event.target.value })}
                      />
                    </FormField>
                  </div>
                  <FormField label="生效星期">
                    <div className="flex flex-wrap gap-3 pt-1">
                      {WEEKDAY_OPTIONS.map((option) => (
                        <Checkbox
                          key={option.value}
                          label={option.label}
                          checked={state.schedule.weekdays.includes(option.value)}
                          onChange={() =>
                            patchSchedule({
                              weekdays: toggleItem(state.schedule.weekdays, option.value),
                            })
                          }
                        />
                      ))}
                    </div>
                  </FormField>
                </div>
              ) : null}
            </FormSection>
          </div>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Link
            to="/rules"
            className="inline-flex h-9 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3.5 text-sm text-slate-200 hover:bg-slate-800"
          >
            取消
          </Link>
          <Button variant="primary" loading={saving} onClick={handleSubmit}>
            保存规则
          </Button>
        </div>
      </div>
    </>
  );
}
