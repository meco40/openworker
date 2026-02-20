import { describe, expect, it } from 'vitest';
import { routeMessage } from '@/server/channels/messages/messageRouter';

describe('routeMessage', () => {
  it('routes /new and /reset to session-command', () => {
    expect(routeMessage('/new Projekt A')).toEqual({
      target: 'session-command',
      payload: 'Projekt A',
      command: '/new',
    });
    expect(routeMessage('/reset')).toEqual({
      target: 'session-command',
      payload: '',
      command: '/reset',
    });
  });

  it('routes /persona to persona-command', () => {
    expect(routeMessage('/persona list')).toEqual({
      target: 'persona-command',
      payload: 'list',
      command: '/persona',
    });
  });

  it('routes /cron to automation-command', () => {
    expect(routeMessage('/cron list')).toEqual({
      target: 'automation-command',
      payload: 'list',
      command: '/cron',
    });
  });

  it('routes /shell and /bash to shell-command', () => {
    expect(routeMessage('/shell echo hello')).toEqual({
      target: 'shell-command',
      payload: 'echo hello',
      command: '/shell',
    });
    expect(routeMessage('/bash ls -la')).toEqual({
      target: 'shell-command',
      payload: 'ls -la',
      command: '/bash',
    });
  });

  it('routes ! prefix to shell-command', () => {
    expect(routeMessage('!pwd')).toEqual({
      target: 'shell-command',
      payload: 'pwd',
      command: '!',
    });
  });

  it('routes /subagents, /kill and /steer to subagent-command', () => {
    expect(routeMessage('/subagents list')).toEqual({
      target: 'subagent-command',
      payload: 'list',
      command: '/subagents',
    });
    expect(routeMessage('/kill all')).toEqual({
      target: 'subagent-command',
      payload: 'all',
      command: '/kill',
    });
    expect(routeMessage('/steer #1 weiter pruefen')).toEqual({
      target: 'subagent-command',
      payload: '#1 weiter pruefen',
      command: '/steer',
    });
  });

  it('treats old worker commands as normal chat', () => {
    expect(routeMessage('@worker Erstelle eine App')).toEqual({
      target: 'chat',
      payload: '@worker Erstelle eine App',
    });
    expect(routeMessage('/worker-status task-1')).toEqual({
      target: 'chat',
      payload: '/worker-status task-1',
    });
    expect(routeMessage('/approve task-1')).toEqual({
      target: 'chat',
      payload: '/approve task-1',
    });
  });

  it('routes normal text to chat', () => {
    expect(routeMessage('Wie geht es dir?')).toEqual({
      target: 'chat',
      payload: 'Wie geht es dir?',
    });
  });

  it('keeps unknown slash commands in chat', () => {
    expect(routeMessage('/work something')).toEqual({
      target: 'chat',
      payload: '/work something',
    });
  });

  it('handles empty and whitespace input', () => {
    expect(routeMessage('')).toEqual({ target: 'chat', payload: '' });
    expect(routeMessage('   ')).toEqual({ target: 'chat', payload: '' });
  });
});
