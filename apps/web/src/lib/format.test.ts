import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_FLAGS,
  CAPABILITY_LABELS,
  CONNECTION_STATE_LABELS,
  PLATFORM_LABELS,
  connectionLabel,
  conversationKindLabel,
  deliveryStatusLabel,
  platformLabel,
} from './constants';
import {
  buildQuery,
  formatDateTime,
  formatDuration,
  formatNumber,
  joinIdList,
  parseIdList,
  parseLineList,
} from './format';

describe('平台与状态文案映射', () => {
  it('映射平台标签', () => {
    expect(platformLabel('discord')).toBe('Discord');
    expect(platformLabel('qq-official')).toBe('QQ 官方机器人');
    expect(PLATFORM_LABELS.discord).toBe('Discord');
  });

  it('映射全部连接状态的中文文案', () => {
    expect(connectionLabel('connected')).toBe('已连接');
    expect(connectionLabel('connecting')).toBe('连接中');
    expect(connectionLabel('reconnecting')).toBe('重连中');
    expect(connectionLabel('disconnected')).toBe('已断开');
    expect(connectionLabel('error')).toBe('异常');
    expect(connectionLabel('disabled')).toBe('已停用');
    expect(connectionLabel('unconfigured')).toBe('未配置');
    expect(Object.keys(CONNECTION_STATE_LABELS)).toHaveLength(7);
  });

  it('未知状态原样回退', () => {
    expect(connectionLabel('something-else')).toBe('something-else');
  });

  it('映射投递状态与会话类型', () => {
    expect(deliveryStatusLabel('queued')).toBe('排队中');
    expect(deliveryStatusLabel('sent')).toBe('已发送');
    expect(deliveryStatusLabel('dead')).toBe('死信');
    expect(conversationKindLabel('private')).toBe('私聊');
    expect(conversationKindLabel('group')).toBe('群聊');
    expect(conversationKindLabel('channel')).toBe('频道');
  });

  it('覆盖 8 个平台能力文案', () => {
    expect(CAPABILITY_FLAGS).toHaveLength(8);
    for (const flag of CAPABILITY_FLAGS) {
      expect(CAPABILITY_LABELS[flag].length).toBeGreaterThan(0);
    }
  });
});

describe('时间格式化', () => {
  it('把 ISO 时间格式化为本地时间字符串', () => {
    expect(formatDateTime('2024-05-06T07:08:09.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('空值与非法值返回占位符', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('格式化运行时长', () => {
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(59)).toBe('59 秒');
    expect(formatDuration(60)).toBe('1 分');
    expect(formatDuration(3725)).toBe('1 小时 2 分');
    expect(formatDuration(90_000)).toBe('1 天 1 小时');
    expect(formatDuration(-1)).toBe('—');
  });

  it('格式化数字', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(1234567)).toMatch(/^1[,.\s]?234[,.\s]?567$/);
    expect(formatNumber(null)).toBe('—');
  });
});

describe('分页与查询参数拼接', () => {
  it('拼接分页参数', () => {
    expect(buildQuery({ page: 2, pageSize: 20 })).toBe('page=2&pageSize=20');
  });

  it('跳过空字符串与 undefined', () => {
    expect(buildQuery({ platform: '', search: undefined, level: 'info', page: 1 })).toBe(
      'level=info&page=1',
    );
  });

  it('编码特殊字符', () => {
    expect(buildQuery({ search: 'a b&c' })).toBe('search=a+b%26c');
    expect(buildQuery({ search: '中文' })).toBe('search=%E4%B8%AD%E6%96%87');
  });

  it('无参数时返回空串', () => {
    expect(buildQuery({})).toBe('');
  });
});

describe('ID 列表解析', () => {
  it('按空格、逗号、换行拆分并去重', () => {
    expect(parseIdList('1, 2\n3 1')).toEqual(['1', '2', '3']);
    expect(parseIdList('   ')).toEqual([]);
    expect(parseIdList(null)).toEqual([]);
  });

  it('parseLineList 保留短语内部空格', () => {
    expect(parseLineList('hello world\nfoo, bar')).toEqual(['hello world', 'foo', 'bar']);
  });

  it('joinIdList 使用换行连接', () => {
    expect(joinIdList(['a', 'b'])).toBe('a\nb');
    expect(joinIdList([])).toBe('');
  });
});
