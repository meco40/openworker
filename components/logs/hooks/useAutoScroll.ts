'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';

interface UseAutoScrollOptions {
  deps: unknown[];
}

export function useAutoScroll<T extends HTMLElement>(options: UseAutoScrollOptions) {
  const { deps } = options;
  const scrollRef = useRef<T>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll when content changes
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev;
      if (next) {
        // If enabling, scroll to bottom immediately
        setTimeout(scrollToBottom, 0);
      }
      return next;
    });
  }, [scrollToBottom]);

  return {
    scrollRef,
    autoScroll,
    setAutoScroll,
    handleScroll,
    scrollToBottom,
    toggleAutoScroll,
  };
}
