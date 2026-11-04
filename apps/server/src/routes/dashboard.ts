import type { FastifyInstance } from 'fastify';

import {
  PLATFORM_LABELS,
  type DashboardSummary,
  type PlatformCount,
} from '@omni-relay/shared-types';

import type { RouteContext, RouteGuard } from './context.js';

export function registerDashboardRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  app.get('/api/dashboard', { preHandler: guard }, async () => {
    const { runtime } = context;
    const status = runtime.getStatus();
    const outbox = runtime.storage.outbox.stats();
    const ruleCounts = runtime.storage.rules.counts();
    const byPlatform = runtime.storage.messages.countByPlatformLast24h();
    const trend = runtime.storage.messages.trendLast24h();
    const recentErrors = runtime.storage.logs.recentErrors(5).map((entry) => ({
      id: entry.id,
      time: entry.time,
      level: entry.level === 'warn' ? ('warn' as const) : ('error' as const),
      code: entry.event ?? entry.level,
      message: entry.msg,
    }));

    const platformCounts: PlatformCount[] = byPlatform.map((entry) => ({
      platform: entry.platform,
      count: entry.count,
    }));
    for (const platform of ['discord', 'qq-official'] as const) {
      if (!platformCounts.some((entry) => entry.platform === platform)) {
        platformCounts.push({ platform, count: 0 });
      }
    }

    const summary: DashboardSummary = {
      generatedAt: new Date().toISOString(),
      uptimeSeconds: status.uptimeSeconds,
      version: context.runtime.getSettingsView().version,
      platforms: status.platforms.map((entry) => ({
        platform: entry.platform,
        label: PLATFORM_LABELS[entry.platform],
        enabled: entry.enabled,
        connection: entry.connection,
        lastEventAt: entry.lastEventAt,
      })),
      activePlatforms: status.platforms.filter((entry) => entry.enabled).length,
      onebot: {
        connected: status.onebot.connected,
        clients: status.onebot.clients,
        lastEventAt: status.onebot.lastEventAt,
        pendingActions: status.onebot.pendingActions,
      },
      queue: {
        queued: outbox.queued,
        sending: outbox.sending,
        retrying: outbox.retrying,
        dead: outbox.dead,
        sent24h: outbox.sent24h,
        failed24h: outbox.failed24h,
      },
      messages: {
        last24h: runtime.storage.messages.countLast24h(),
        trend,
        byPlatform: platformCounts.sort((a, b) => b.count - a.count),
      },
      rules: {
        total: ruleCounts.total,
        enabled: ruleCounts.enabled,
      },
      replyPolicy: {
        defaultMode: runtime.getReplyPolicy().defaultMode,
      },
      recentErrors,
    };

    return summary;
  });
}
