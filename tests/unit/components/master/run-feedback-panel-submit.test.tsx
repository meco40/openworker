import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunFeedbackPanel } from '@/modules/master/components/RunFeedbackPanel';

function selectRating(stars: number) {
  fireEvent.click(screen.getByRole('button', { name: `${stars} stars` }));
}

function createDeferred<T>() {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (!resolveValue) throw new Error('Deferred resolve missing');
      resolveValue(value);
    },
  };
}

describe('RunFeedbackPanel submit behavior', () => {
  it('shows success only after server-confirmed submit', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    render(<RunFeedbackPanel runId="run-1" loading={false} onSubmit={onSubmit} />);

    selectRating(5);
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/feedback submitted/i)).toBeInTheDocument();
  });

  it('keeps form visible and shows inline error on failed submit', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false as const, error: 'Server down' }));
    render(<RunFeedbackPanel runId="run-2" loading={false} onSubmit={onSubmit} />);

    selectRating(4);
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/feedback submitted/i)).not.toBeInTheDocument();
    expect(screen.getByText('Server down')).toBeInTheDocument();
  });

  it('prevents duplicate submits while one request is in flight', async () => {
    const deferred = createDeferred<{ ok: true }>();
    const onSubmit = vi.fn(() => deferred.promise);
    render(<RunFeedbackPanel runId="run-3" loading={false} onSubmit={onSubmit} />);

    selectRating(3);
    const submit = screen.getByRole('button', { name: /submit feedback/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);

    deferred.resolve({ ok: true });
    await waitFor(() => {
      expect(screen.getByText(/feedback submitted/i)).toBeInTheDocument();
    });
  });
});
