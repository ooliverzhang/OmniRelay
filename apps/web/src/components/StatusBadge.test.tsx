import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge, StatusBadge } from './StatusBadge';

const STATUS_CASES: Array<[string, string]> = [
  ['connected', '已连接'],
  ['connecting', '连接中'],
  ['reconnecting', '重连中'],
  ['disconnected', '已断开'],
  ['error', '异常'],
  ['disabled', '已停用'],
  ['unconfigured', '未配置'],
];

describe('StatusBadge', () => {
  for (const [status, label] of STATUS_CASES) {
    it(`渲染 ${status} 的中文文案 ${label}`, () => {
      render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
    });
  }

  it('未知状态回退为原始文本', () => {
    render(<StatusBadge status="mystery-state" />);
    expect(screen.getByText('mystery-state')).toBeTruthy();
  });

  it('支持自定义文案覆盖默认映射', () => {
    render(<StatusBadge status="connected" label="在线" />);
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.queryByText('已连接')).toBeNull();
  });

  it('使用 role=status 无关的语义化文本节点展示', () => {
    render(<Badge tone="info">信息徽标</Badge>);
    expect(screen.getByText('信息徽标')).toBeTruthy();
  });
});
