'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type ConfirmTone = 'default' | 'danger';

interface ConfirmOptions {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface AlertOptions {
  title?: string;
  description: string;
  ackLabel?: string;
  tone?: ConfirmTone;
}

type ConfirmInput = string | ConfirmOptions;
type AlertInput = string | AlertOptions;

interface ConfirmRequest {
  id: number;
  mode: 'confirm' | 'alert';
  options: ConfirmOptions;
  resolve: (_value: boolean) => void;
}

interface ConfirmDialogApi {
  confirm: (_input: ConfirmInput) => Promise<boolean>;
  alert: (_input: AlertInput) => Promise<void>;
}

const ConfirmDialogContext = createContext<ConfirmDialogApi | null>(null);

function normalizeConfirmInput(input: ConfirmInput): ConfirmOptions {
  if (typeof input === 'string') {
    return {
      description: input,
    };
  }
  return input;
}

function normalizeAlertInput(input: AlertInput): ConfirmOptions {
  if (typeof input === 'string') {
    return {
      description: input,
      confirmLabel: 'OK',
    };
  }
  return {
    title: input.title,
    description: input.description,
    confirmLabel: input.ackLabel ?? 'OK',
    tone: input.tone,
  };
}

function defaultTitle(options: ConfirmOptions, mode: ConfirmRequest['mode']): string {
  if (options.title) {
    return options.title;
  }
  if (mode === 'alert') {
    return 'Hinweis';
  }
  return options.tone === 'danger' ? 'Bitte bestaetigen' : 'Bestaetigung';
}

function getMessageFromInput(input: ConfirmInput | AlertInput): string {
  return typeof input === 'string' ? input : input.description;
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const queueRef = useRef<ConfirmRequest[]>([]);
  const activeRef = useRef<ConfirmRequest | null>(null);
  const idRef = useRef(0);
  const [active, setActive] = useState<ConfirmRequest | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  const settleActive = useCallback((value: boolean) => {
    setActive((current) => {
      if (!current) {
        return null;
      }
      current.resolve(value);
      const next = queueRef.current.shift() ?? null;
      activeRef.current = next;
      return next;
    });
  }, []);

  const pushRequest = useCallback((request: ConfirmRequest) => {
    setActive((current) => {
      if (current) {
        queueRef.current.push(request);
        activeRef.current = current;
        return current;
      }
      activeRef.current = request;
      return request;
    });
  }, []);

  const confirm = useCallback(
    (input: ConfirmInput) =>
      new Promise<boolean>((resolve) => {
        const options = normalizeConfirmInput(input);
        const request: ConfirmRequest = {
          id: ++idRef.current,
          mode: 'confirm',
          options,
          resolve,
        };
        pushRequest(request);
      }),
    [pushRequest],
  );

  const alert = useCallback(
    async (input: AlertInput) => {
      await new Promise<boolean>((resolve) => {
        const options = normalizeAlertInput(input);
        const request: ConfirmRequest = {
          id: ++idRef.current,
          mode: 'alert',
          options,
          resolve,
        };
        pushRequest(request);
      });
    },
    [pushRequest],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (active.mode === 'alert') {
        confirmButtonRef.current?.focus();
      } else if (active.options.tone === 'danger') {
        cancelButtonRef.current?.focus();
      } else {
        confirmButtonRef.current?.focus();
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active]);

  useEffect(() => {
    return () => {
      const current = activeRef.current;
      if (current) {
        current.resolve(false);
      }
      for (const request of queueRef.current) {
        request.resolve(false);
      }
      queueRef.current = [];
      activeRef.current = null;
    };
  }, []);

  const value = useMemo<ConfirmDialogApi>(
    () => ({
      confirm,
      alert,
    }),
    [alert, confirm],
  );

  return (
    <ConfirmDialogContext.Provider value={value}>
      {children}
      {active ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close confirm dialog"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => settleActive(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`confirm-dialog-title-${active.id}`}
            aria-describedby={`confirm-dialog-description-${active.id}`}
            className="relative z-10 w-full max-w-md rounded-xl border border-zinc-700/70 bg-zinc-900 p-5 shadow-2xl"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                settleActive(false);
              }
            }}
          >
            <h2
              id={`confirm-dialog-title-${active.id}`}
              className="text-base font-semibold text-zinc-100"
            >
              {defaultTitle(active.options, active.mode)}
            </h2>
            <p
              id={`confirm-dialog-description-${active.id}`}
              className="mt-2 text-sm leading-relaxed text-zinc-300"
            >
              {active.options.description}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              {active.mode === 'confirm' ? (
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => settleActive(false)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
                >
                  {active.options.cancelLabel ?? 'Abbrechen'}
                </button>
              ) : null}
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={() => settleActive(true)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition focus:outline-none focus-visible:ring-2 ${
                  active.options.tone === 'danger'
                    ? 'bg-red-700 hover:bg-red-600 focus-visible:ring-red-400'
                    : 'bg-blue-700 hover:bg-blue-600 focus-visible:ring-blue-400'
                }`}
              >
                {active.options.confirmLabel ?? 'Bestaetigen'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog() {
  const context = useContext(ConfirmDialogContext);
  return useCallback(
    async (input: ConfirmInput) => {
      if (context) {
        return context.confirm(input);
      }
      if (typeof window === 'undefined') {
        return true;
      }
      return window.confirm(getMessageFromInput(input));
    },
    [context],
  );
}

export function useAlertDialog() {
  const context = useContext(ConfirmDialogContext);
  return useCallback(
    async (input: AlertInput) => {
      if (context) {
        await context.alert(input);
        return;
      }
      if (typeof window === 'undefined') {
        return;
      }
      window.alert(getMessageFromInput(input));
    },
    [context],
  );
}
