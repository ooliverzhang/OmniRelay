import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useDeleteRule, useReorderRules, useRuleTest, useRules, useToggleRule } from '../api/hooks';
import type { ConversationKind, Platform, RuleTestRequest, RuleView } from '../api/types';
import { Button } from '../components/Button';
import { Card, PageHeader } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Checkbox, FormField, Select, TextInput, Toggle } from '../components/Field';
import { DataTable, type Column } from '../components/Table';
import { Badge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import {
  CONVERSATION_KIND_OPTIONS,
  PLATFORM_OPTIONS,
  conversationKindLabel,
  platformLabel,
  ruleDecisionLabel,
  ruleDecisionTone,
} from '../lib/constants';
import { errorMessage, truncate } from '../lib/format';

export function RulesPage() {
  const rulesQuery = useRules();
  const toggleRule = useToggleRule();
  const reorderRules = useReorderRules();
  const deleteRule = useDeleteRule();
  const testMutation = useRuleTest();
  const toast = useToast();

  const [pendingDelete, setPendingDelete] = useState<RuleView | null>(null);

  const [testPlatform, setTestPlatform] = useState<Platform>('discord');
  const [testKind, setTestKind] = useState<ConversationKind>('group');
  const [testConversationId, setTestConversationId] = useState('');
  const [testUserId, setTestUserId] = useState('');
  const [testText, setTestText] = useState('');
  const [testMention, setTestMention] = useState(false);
  const [testReplyToBot, setTestReplyToBot] = useState(false);
  const [testRuleId, setTestRuleId] = useState('');

  const rules = rulesQuery.data?.items ?? [];

  const handleToggle = (rule: RuleView) => {
    toggleRule.mutate(
      { id: rule.id, enabled: !rule.enabled },
      {
        onSuccess: (updated) =>
          toast.success(`规则「${updated.name}」已${updated.enabled ? '启用' : '停用'}`),
        onError: (error) => toast.error(errorMessage(error, '更新规则状态失败')),
      },
    );
  };

  const moveRule = (index: number, delta: number) => {
    const target = index + delta;
    const current = rules[index];
    const swapped = rules[target];
    if (!current || !swapped) return;
    const next = [...rules];
    next[index] = swapped;
    next[target] = current;
    reorderRules.mutate(
      next.map((rule) => rule.id),
      {
        onSuccess: () => toast.success('规则顺序已更新'),
        onError: (error) => toast.error(errorMessage(error, '调整顺序失败')),
      },
    );
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteRule.mutate(pendingDelete.id, {
      onSuccess: () => {
        toast.success(`规则「${pendingDelete.name}」已删除`);
        setPendingDelete(null);
      },
      onError: (error) => toast.error(errorMessage(error, '删除规则失败')),
    });
  };

  const handleTest = () => {
    const payload: RuleTestRequest = {
      platform: testPlatform,
      conversationKind: testKind,
      text: testText,
      mention: testMention,
      replyToBot: testReplyToBot,
    };
    if (testConversationId.trim()) payload.conversationId = testConversationId.trim();
    if (testUserId.trim()) payload.userId = testUserId.trim();
    if (testRuleId) payload.ruleIds = [testRuleId];

    testMutation.mutate(payload, {
      onError: (error) => toast.error(errorMessage(error, '规则测试失败')),
    });
  };

  const columns: Array<Column<RuleView>> = [
    {
      key: 'name',
      header: '名称',
      render: (rule) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-200">{rule.name}</p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">{rule.id}</p>
        </div>
      ),
    },
    {
      key: 'priority',
      header: '优先级',
      align: 'center',
      render: (rule) => <span className="tabular-nums text-slate-300">{rule.priority}</span>,
    },
    {
      key: 'platforms',
      header: '平台',
      render: (rule) =>
        rule.platforms.length === 0 ? (
          <span className="text-xs text-slate-500">全部</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {rule.platforms.map((platform) => (
              <Badge key={platform} tone="info">
                {platformLabel(platform)}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: 'kinds',
      header: '会话类型',
      render: (rule) =>
        rule.conversationKinds.length === 0 ? (
          <span className="text-xs text-slate-500">全部</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {rule.conversationKinds.map((kind) => (
              <Badge key={kind} tone="neutral">
                {conversationKindLabel(kind)}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: 'enabled',
      header: '启用',
      align: 'center',
      render: (rule) => (
        <div className="flex justify-center">
          <Toggle
            checked={rule.enabled}
            disabled={toggleRule.isPending}
            label={`${rule.name} 启用开关`}
            onChange={() => handleToggle(rule)}
          />
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (rule) => {
        const index = rules.findIndex((item) => item.id === rule.id);
        return (
          <div className="flex items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={index <= 0 || reorderRules.isPending}
              onClick={() => moveRule(index, -1)}
            >
              上移
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={index < 0 || index >= rules.length - 1 || reorderRules.isPending}
              onClick={() => moveRule(index, 1)}
            >
              下移
            </Button>
            <Link
              to={`/rules/${rule.id}/edit`}
              className="inline-flex h-8 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-xs text-slate-200 hover:bg-slate-800"
            >
              编辑
            </Link>
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-300 hover:bg-rose-500/10"
              onClick={() => setPendingDelete(rule)}
            >
              删除
            </Button>
          </div>
        );
      },
    },
  ];

  const evaluatedColumns: Array<
    Column<{ id: string; name: string; matched: boolean; reason: string }>
  > = [
    {
      key: 'name',
      header: '规则',
      render: (row) => <span className="text-slate-200">{row.name}</span>,
    },
    {
      key: 'matched',
      header: '结果',
      align: 'center',
      render: (row) => (
        <Badge tone={row.matched ? 'success' : 'neutral'}>{row.matched ? '命中' : '未命中'}</Badge>
      ),
    },
    {
      key: 'reason',
      header: '原因',
      render: (row) => (
        <span className="font-mono text-xs text-slate-400">{row.reason || '—'}</span>
      ),
    },
  ];

  const testResult = testMutation.data;

  return (
    <>
      <PageHeader
        title="规则"
        description="按优先级依次评估的消息匹配规则"
        actions={
          <>
            <Button
              size="sm"
              onClick={() => {
                void rulesQuery.refetch();
              }}
              loading={rulesQuery.isFetching}
            >
              刷新
            </Button>
            <Link
              to="/rules/new"
              className="inline-flex h-8 items-center rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-500"
            >
              新建规则
            </Link>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={rulesQuery.data?.items}
        rowKey={(rule) => rule.id}
        loading={rulesQuery.isLoading}
        error={rulesQuery.isError ? errorMessage(rulesQuery.error, '规则列表加载失败') : null}
        onRetry={() => {
          void rulesQuery.refetch();
        }}
        emptyText="暂无规则"
        emptyHint="新建规则后，符合条件的新消息将自动回复"
        minWidthClassName="min-w-[900px]"
      />

      <Card
        className="mt-4"
        title="规则测试器"
        description="使用离线规则引擎预演，不会产生任何真实消息"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <FormField label="平台" htmlFor="test-platform">
            <Select
              id="test-platform"
              value={testPlatform}
              onChange={(event) => setTestPlatform(event.target.value as Platform)}
            >
              {PLATFORM_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="会话类型" htmlFor="test-kind">
            <Select
              id="test-kind"
              value={testKind}
              onChange={(event) => setTestKind(event.target.value as ConversationKind)}
            >
              {CONVERSATION_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="指定规则（可选）" htmlFor="test-rule" hint="留空表示评估全部规则">
            <Select
              id="test-rule"
              value={testRuleId}
              onChange={(event) => setTestRuleId(event.target.value)}
            >
              <option value="">全部规则</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="会话 ID" htmlFor="test-conversation">
            <TextInput
              id="test-conversation"
              value={testConversationId}
              onChange={(event) => setTestConversationId(event.target.value)}
              placeholder="如 123456789"
            />
          </FormField>

          <FormField label="用户 ID" htmlFor="test-user">
            <TextInput
              id="test-user"
              value={testUserId}
              onChange={(event) => setTestUserId(event.target.value)}
              placeholder="如 987654321"
            />
          </FormField>

          <FormField label="消息文本" htmlFor="test-text" className="md:col-span-2 xl:col-span-1">
            <TextInput
              id="test-text"
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
              placeholder="输入用于测试的消息内容"
            />
          </FormField>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Checkbox
            label="@ 机器人"
            checked={testMention}
            onChange={(event) => setTestMention(event.target.checked)}
          />
          <Checkbox
            label="回复机器人消息"
            checked={testReplyToBot}
            onChange={(event) => setTestReplyToBot(event.target.checked)}
          />
          <Button
            variant="primary"
            className="ml-auto"
            loading={testMutation.isPending}
            onClick={handleTest}
          >
            运行测试
          </Button>
        </div>

        {testResult ? (
          <div className="mt-5 space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={testResult.matched ? 'success' : 'neutral'}>
                {testResult.matched ? '命中规则' : '未命中规则'}
              </Badge>
              <Badge tone={ruleDecisionTone(testResult.decision)}>
                决策：{ruleDecisionLabel(testResult.decision)}
              </Badge>
              <Badge tone="info">状态：{testResult.status}</Badge>
              <Badge tone="neutral">策略模式：{testResult.appliedPolicyMode}</Badge>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-slate-500">原因 (reason)</dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-slate-300">
                  {testResult.reason || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">说明 (explanation)</dt>
                <dd className="mt-0.5 break-words text-xs text-slate-300">
                  {truncate(testResult.explanation, 300)}
                </dd>
              </div>
            </dl>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                评估明细
              </p>
              <DataTable
                columns={evaluatedColumns}
                rows={testResult.evaluatedRules}
                rowKey={(row) => row.id}
                emptyText="没有参与评估的规则"
                minWidthClassName="min-w-[420px]"
              />
            </div>
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除规则"
        description={
          pendingDelete ? `确定要删除规则「${pendingDelete.name}」吗？该操作不可撤销。` : undefined
        }
        confirmText="删除"
        loading={deleteRule.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
