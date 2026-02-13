export const CLAWHUB_CHANGED_EVENT = 'clawhub:changed';

export interface ClawHubEventTarget {
  addEventListener(type: string, callback: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, callback: EventListenerOrEventListenerObject): void;
  dispatchEvent(event: Event): boolean;
}

export function emitClawHubChanged(target?: ClawHubEventTarget | null): void {
  if (target) {
    target.dispatchEvent(new Event(CLAWHUB_CHANGED_EVENT));
    return;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CLAWHUB_CHANGED_EVENT));
  }
}

export function subscribeClawHubChanged(
  target: ClawHubEventTarget | null | undefined,
  onChanged: () => void,
): () => void {
  if (!target) {
    return () => {
      // no-op cleanup for non-browser contexts
    };
  }
  const handler: EventListener = () => {
    onChanged();
  };
  target.addEventListener(CLAWHUB_CHANGED_EVENT, handler);
  return () => {
    target.removeEventListener(CLAWHUB_CHANGED_EVENT, handler);
  };
}
