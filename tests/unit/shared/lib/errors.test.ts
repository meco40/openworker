import { describe, it, expect } from 'vitest';
import { toErrorMessage } from '@/shared/lib/errors';

describe('toErrorMessage', () => {
  it('returns error message from Error instance', () => {
    const error = new Error('Test error message');
    expect(toErrorMessage(error)).toBe('Test error message');
  });

  it('returns string representation for non-Error objects', () => {
    expect(toErrorMessage('string error')).toBe('string error');
    expect(toErrorMessage(123)).toBe('123');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage({ message: 'obj' })).toBe('[object Object]');
  });

  it('handles Error subclasses correctly', () => {
    const typeError = new TypeError('Type error');
    expect(toErrorMessage(typeError)).toBe('Type error');

    const syntaxError = new SyntaxError('Syntax error');
    expect(toErrorMessage(syntaxError)).toBe('Syntax error');
  });

  it('handles empty error messages', () => {
    const emptyError = new Error('');
    expect(toErrorMessage(emptyError)).toBe('');
  });
});
