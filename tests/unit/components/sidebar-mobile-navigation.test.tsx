import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { View } from '@/shared/domain/types';

describe('Sidebar mobile navigation', () => {
  it('opens with visible labels, closes with Escape, and restores trigger focus', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    try {
      render(<Sidebar activeView={View.DASHBOARD} onViewChange={() => {}} />);

      const trigger = screen.getByRole('button', { name: 'Open navigation' });
      fireEvent.click(trigger);

      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('dialog', { name: 'OpenClaw navigation' })).toHaveAttribute(
        'aria-modal',
        'true',
      );
      expect(screen.getAllByText('Multi-Channel Inbox')).toHaveLength(2);

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByTestId('mobile-navigation-drawer')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    } finally {
      requestAnimationFrameSpy.mockRestore();
    }
  });

  it('keeps keyboard focus inside the open drawer', () => {
    render(<Sidebar activeView={View.DASHBOARD} onViewChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    const closeButton = screen.getByRole('button', { name: 'Close navigation' });
    const profileButton = screen
      .getAllByRole('button', { name: 'Operator Profile' })
      .at(-1) as HTMLElement;

    profileButton.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(profileButton).toHaveFocus();
  });

  it('navigates, closes the drawer, and moves focus to main content', () => {
    const onViewChange = vi.fn();
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.append(main);
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    try {
      render(<Sidebar activeView={View.DASHBOARD} onViewChange={onViewChange} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Multi-Channel Inbox' }).at(-1) as HTMLElement,
      );

      expect(onViewChange).toHaveBeenCalledWith(View.CHAT);
      expect(screen.queryByTestId('mobile-navigation-drawer')).not.toBeInTheDocument();
      expect(main).toHaveFocus();
    } finally {
      requestAnimationFrameSpy.mockRestore();
      main.remove();
    }
  });
});
