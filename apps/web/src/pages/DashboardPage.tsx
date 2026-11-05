import { useDashboard } from '../api/hooks';
import { PageHeader, StatCard, Card } from '../components/Card';
import { Chart, type EChartsCoreOption } from '../components/Chart';
import { Badge, StatusBadge } from '../components/StatusBadge';
import { EmptyState, ErrorState, LoadingBlock } from '../components/EmptyState';
import { Button } from '../components/Button';
import { DASHBOARD_REFRESH_MS, REPLY_POLICY_MODE_LABELS, platformLabel } from '../lib/constants';
import {
  errorMessage,
  formatDateTime,
  formatDuration,
  formatHourLabel,
  formatNumber,
  formatRelative,
} from '../lib/format';

const PLATFORM_COLORS: Record<string, string> = {
  discord: '#818cf8',
  'qq-official': '#34d399',
};

const fallbackColor = '#94a3b8';

export function DashboardPage() {
  const dashboard = useDashboard();
  const data = dashboard.data;

  if (dashboard.isLoading) {
    return (
      <>
        <PageHeader title="仪表盘" description="实时监控各平台的连接状态与消息流量" />
        <LoadingBlock text="正在加载仪表盘…" />
      </>
    );
  }

  if (dashboard.isError || !data) {
    return (
      <>
        <PageHeader title="仪表盘" description="实时监控各平台的连接状态与消息流量" />
        <div className="surface">
          <ErrorState
            message={errorMessage(dashboard.error, '仪表盘加载失败')}
            onRetry={() => {
              void dashboard.refetch();
            }}
          />
        </div>
      </>
    );
  }

  const discord = data.platforms.find((item) => item.platform === 'discord');
  const qq = data.platforms.find((item) => item.platform === 'qq-official');

  const trend = data.messages.trend ?? [];
  const trendPlatforms = data.platforms.length
    ? data.platforms
    : [{ platform: 'discord', label: 'Discord' }];
  const recentErrors = data.recentErrors ?? [];

  const trendOption: EChartsCoreOption = {
    backgroundColor: 'transparent',
    grid: { left: 4, right: 16, top: 34, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0f172a',
      borderColor: '#1e293b',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: '#94a3b8', fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10,
      icon: 'roundRect',
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: trend.map((point) => formatHourLabel(point.bucket)),
      axisLine: { lineStyle: { color: '#1e293b' } },
      axisTick: { show: false },
      axisLabel: { color: '#64748b', fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
      axisLabel: { color: '#64748b', fontSize: 10 },
    },
    series: trendPlatforms.map((platform) => {
      const color = PLATFORM_COLORS[platform.platform] ?? fallbackColor;
      return {
        name: platform.label,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        areaStyle: { color, opacity: 0.12 },
        data: trend.map((point) => point.byPlatform?.[platform.platform] ?? 0),
      };
    }),
  };

  const platformCounts = data.messages.byPlatform ?? [];
  const pieOption: EChartsCoreOption = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: '#0f172a',
      borderColor: '#1e293b',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    legend: {
      bottom: 0,
      textStyle: { color: '#94a3b8', fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10,
      icon: 'roundRect',
    },
    series: [
      {
        name: '平台消息量',
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#020617', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: false } },
        data: platformCounts.map((item) => ({
          name: platformLabel(item.platform),
          value: item.count,
          itemStyle: { color: PLATFORM_COLORS[item.platform] ?? fallbackColor },
        })),
      },
    ],
  };

  return (
    <>
      <PageHeader
        title="仪表盘"
        description={`版本 ${data.version} · 运行 ${formatDuration(data.uptimeSeconds)} · 每 ${DASHBOARD_REFRESH_MS / 1000} 秒自动刷新`}
        actions={
          <Button
            size="sm"
            onClick={() => {
              void dashboard.refetch();
            }}
            loading={dashboard.isFetching}
          >
            刷新
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Discord 连接状态"
          value={<StatusBadge status={discord?.connection ?? 'unconfigured'} />}
          hint={discord ? `最后事件：${formatRelative(discord.lastEventAt)}` : '未配置该平台'}
          accent="indigo"
        />
        <StatCard
          label="QQ 官方机器人"
          value={<StatusBadge status={qq?.connection ?? 'unconfigured'} />}
          hint={qq ? `最后事件：${formatRelative(qq.lastEventAt)}` : '未配置该平台'}
          accent="emerald"
        />
        <StatCard
          label="OneBot WebSocket"
          value={<StatusBadge status={data.onebot.connected ? 'connected' : 'disconnected'} />}
          hint={`客户端 ${data.onebot.clients} · 待处理动作 ${data.onebot.pendingActions}`}
          accent="indigo"
        />
        <StatCard
          label="启用平台数"
          value={formatNumber(data.activePlatforms)}
          hint={`共 ${data.platforms.length} 个平台`}
          accent="slate"
        />
        <StatCard
          label="最近 24h 消息"
          value={formatNumber(data.messages.last24h)}
          hint={`发送成功 ${formatNumber(data.queue.sent24h)} · 失败 ${formatNumber(data.queue.failed24h)}`}
          accent="indigo"
        />
        <StatCard
          label="待发送队列"
          value={formatNumber(data.queue.queued + data.queue.sending + data.queue.retrying)}
          hint={`排队 ${data.queue.queued} · 发送中 ${data.queue.sending} · 重试 ${data.queue.retrying}`}
          accent="amber"
        />
        <StatCard
          label="死信数"
          value={formatNumber(data.queue.dead)}
          hint="超过重试上限的消息"
          accent={data.queue.dead > 0 ? 'rose' : 'slate'}
        />
        <StatCard
          label="规则总数"
          value={`${data.rules.enabled} / ${data.rules.total}`}
          hint={`默认回复模式：${REPLY_POLICY_MODE_LABELS[data.replyPolicy.defaultMode]}`}
          accent="emerald"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="24 小时消息趋势"
          description="按平台分系列的小时级消息量"
          bodyClassName="px-2 pb-3 pt-2"
        >
          {trend.length === 0 ? (
            <EmptyState text="暂无消息趋势数据" hint="有消息进入后会在此显示" />
          ) : (
            <Chart option={trendOption} height={280} />
          )}
        </Card>

        <Card title="各平台消息量" description="最近 24 小时占比" bodyClassName="px-2 pb-3 pt-2">
          {platformCounts.length === 0 ? (
            <EmptyState text="暂无平台消息数据" />
          ) : (
            <Chart option={pieOption} height={280} />
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="最近错误"
        description={`数据生成于 ${formatDateTime(data.generatedAt)}`}
        bodyClassName="p-4"
      >
        {recentErrors.length === 0 ? (
          <EmptyState text="暂无错误记录" />
        ) : (
          <ul className="divide-y divide-slate-800/80">
            {recentErrors.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="w-36 shrink-0 font-mono text-xs text-slate-500">
                  {formatDateTime(item.time)}
                </span>
                <Badge tone={item.level === 'error' ? 'danger' : 'warning'}>{item.level}</Badge>
                <span className="font-mono text-xs text-slate-400">{item.code}</span>
                <span className="min-w-0 flex-1 break-words text-sm text-slate-300">
                  {item.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
