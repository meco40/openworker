import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolPolicyPanel } from '@/modules/master/components/ToolPolicyPanel';

describe('ToolPolicyPanel', () => {
  it('renders current values and saves edited policy', () => {
    const onSave = vi.fn();
    render(
      <ToolPolicyPanel
        policy={{
          security: 'allowlist',
          ask: 'on_miss',
          allowlist: ['shell.exec:D:/web/clawtest:*'],
        }}
        loading={false}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText('Security mode'), { target: { value: 'full' } });
    fireEvent.change(screen.getByLabelText('Ask behavior'), { target: { value: 'always' } });
    fireEvent.change(screen.getByLabelText('Persistent allowlist'), {
      target: { value: 'shell.exec:D:/web/clawtest:*\nnotes:create' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Tool Policy' }));

    expect(onSave).toHaveBeenCalledWith({
      security: 'full',
      ask: 'always',
      allowlist: ['shell.exec:D:/web/clawtest:*', 'notes:create'],
    });
  });
});
