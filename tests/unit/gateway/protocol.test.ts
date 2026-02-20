import { describe, it, expect } from 'vitest';
import {
  parseFrame,
  makeResponse,
  makeError,
  makeEvent,
  makeStream,
} from '@/server/gateway/protocol';

// ─── parseFrame ──────────────────────────────────────────────

describe('parseFrame', () => {
  it('parses a valid request frame with string id', () => {
    const raw = JSON.stringify({
      type: 'req',
      id: 'abc',
      method: 'chat.send',
      params: { text: 'hi' },
    });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: 'req', id: 'abc', method: 'chat.send', params: { text: 'hi' } });
  });

  it('parses a valid request frame with numeric id', () => {
    const raw = JSON.stringify({ type: 'req', id: 42, method: 'logs.list' });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: 'req', id: 42, method: 'logs.list' });
  });

  it('rejects request frame without method', () => {
    const raw = JSON.stringify({ type: 'req', id: '1' });
    expect(parseFrame(raw)).toBeNull();
  });

  it('rejects request frame without id', () => {
    const raw = JSON.stringify({ type: 'req', method: 'test' });
    expect(parseFrame(raw)).toBeNull();
  });

  it('parses a valid response frame', () => {
    const raw = JSON.stringify({ type: 'res', id: '1', ok: true, payload: [1, 2] });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: 'res', id: '1', ok: true, payload: [1, 2] });
  });

  it('rejects response frame without ok boolean', () => {
    const raw = JSON.stringify({ type: 'res', id: '1', ok: 'yes' });
    expect(parseFrame(raw)).toBeNull();
  });

  it('parses a valid event frame', () => {
    const raw = JSON.stringify({ type: 'event', event: 'tick', payload: { ts: 1 }, seq: 5 });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: 'event', event: 'tick', payload: { ts: 1 }, seq: 5 });
  });

  it('rejects event frame without event name', () => {
    const raw = JSON.stringify({ type: 'event' });
    expect(parseFrame(raw)).toBeNull();
  });

  it('parses a valid stream frame', () => {
    const raw = JSON.stringify({ type: 'stream', id: 7, delta: 'Hello', done: false });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: 'stream', id: 7, delta: 'Hello', done: false });
  });

  it('rejects stream frame without delta', () => {
    const raw = JSON.stringify({ type: 'stream', id: '1', done: false });
    expect(parseFrame(raw)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseFrame('{bad json')).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(parseFrame('"hello"')).toBeNull();
  });

  it('returns null for unknown frame type', () => {
    expect(parseFrame(JSON.stringify({ type: 'unknown', id: '1' }))).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(parseFrame(JSON.stringify({ id: '1', method: 'test' }))).toBeNull();
  });
});

// ─── makeResponse ────────────────────────────────────────────

describe('makeResponse', () => {
  it('creates a success response frame', () => {
    const frame = makeResponse('r1', { data: true });
    expect(frame).toEqual({ type: 'res', id: 'r1', ok: true, payload: { data: true } });
  });

  it('accepts numeric id', () => {
    const frame = makeResponse(42, null);
    expect(frame.id).toBe(42);
    expect(frame.ok).toBe(true);
  });
});

// ─── makeError ───────────────────────────────────────────────

describe('makeError', () => {
  it('creates an error response frame', () => {
    const frame = makeError('e1', 'NOT_FOUND', 'Task not found');
    expect(frame).toEqual({
      type: 'res',
      id: 'e1',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });
  });
});

// ─── makeEvent ───────────────────────────────────────────────

describe('makeEvent', () => {
  it('creates an event frame without seq', () => {
    const frame = makeEvent('chat.message', { text: 'hi' });
    expect(frame).toEqual({ type: 'event', event: 'chat.message', payload: { text: 'hi' } });
    expect(frame.seq).toBeUndefined();
  });

  it('creates an event frame with seq', () => {
    const frame = makeEvent('tick', { ts: 1 }, 10);
    expect(frame.seq).toBe(10);
  });
});

// ─── makeStream ──────────────────────────────────────────────

describe('makeStream', () => {
  it('creates a stream frame', () => {
    const frame = makeStream('s1', 'token', false);
    expect(frame).toEqual({ type: 'stream', id: 's1', delta: 'token', done: false });
  });

  it('creates a done frame', () => {
    const frame = makeStream('s1', '', true);
    expect(frame.done).toBe(true);
    expect(frame.delta).toBe('');
  });
});
