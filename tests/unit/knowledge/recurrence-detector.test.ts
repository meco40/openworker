import { describe, it, expect } from 'vitest';
import { detectRecurrence } from '@/server/knowledge/recurrenceDetector';

describe('detectRecurrence', () => {
  it('detects daily recurrence', () => {
    const result = detectRecurrence('Ich gehe jeden Tag joggen');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('daily');
  });

  it('detects weekly recurrence with specific day', () => {
    const result = detectRecurrence('Jeden Montag gehe ich zum Sport');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('weekly');
    expect(result!.day).toBe('montag');
  });

  it('detects monthly recurrence', () => {
    const result = detectRecurrence('Wir treffen uns jeden Monat');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('monthly');
  });

  it('detects generic recurring pattern with "immer"', () => {
    const result = detectRecurrence('Ich esse immer um 12 Uhr');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('recurring');
  });

  it('detects "normalerweise" as recurring', () => {
    const result = detectRecurrence('Normalerweise stehe ich um 7 auf');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('recurring');
  });

  it('returns null for non-recurring text', () => {
    const result = detectRecurrence('Ich war gestern beim Arzt');
    expect(result).toBeNull();
  });

  it('detects "taeglich" as daily', () => {
    const result = detectRecurrence('Ich meditiere taeglich');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('daily');
  });

  it('detects "woechentlich" as weekly (no day)', () => {
    const result = detectRecurrence('Wir telefonieren woechentlich');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('weekly');
    expect(result!.day).toBeUndefined();
  });

  it('detects all weekdays', () => {
    const days = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
    for (const day of days) {
      const result = detectRecurrence(`Jeden ${day} Training`);
      expect(result).not.toBeNull();
      expect(result!.day).toBe(day.toLowerCase());
    }
  });
});
