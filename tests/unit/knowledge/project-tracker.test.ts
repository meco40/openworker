import { describe, it, expect } from 'vitest';
import {
  disambiguateProject,
  detectProjectStatusSignal,
  type ProjectState,
} from '@/server/knowledge/projectTracker';

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    entityId: 'ent-notes2',
    entityName: 'Notes2',
    status: 'in_progress',
    lastWorkedOn: '2026-02-17T10:00:00Z',
    ...overrides,
  };
}

describe('disambiguateProject', () => {
  it('uses existing project when name matches and project is active', () => {
    const projects = [makeProject({ entityId: 'ent-notes2', entityName: 'Notes2' })];
    const result = disambiguateProject('Notes2', projects, 'Weiter am Notes2 arbeiten');
    expect(result.action).toBe('use_existing');
    expect(result.existingId).toBe('ent-notes2');
  });

  it('is case-insensitive on name matching', () => {
    const projects = [makeProject({ entityId: 'ent-notes2', entityName: 'Notes2' })];
    const result = disambiguateProject('notes2', projects, 'notes2 feature');
    expect(result.action).toBe('use_existing');
    expect(result.existingId).toBe('ent-notes2');
  });

  it('creates version when suffix pattern detected (Notes3)', () => {
    const projects = [
      makeProject({ entityId: 'ent-notes', entityName: 'Notes', status: 'deployed' }),
    ];
    const result = disambiguateProject('Notes3', projects, 'Notes3 starten');
    expect(result.action).toBe('create_version');
    expect(result.existingId).toBe('ent-notes');
    expect(result.version).toBe('3');
  });

  it('creates version when v2 suffix detected', () => {
    const projects = [
      makeProject({ entityId: 'ent-dash', entityName: 'Dashboard', status: 'abandoned' }),
    ];
    const result = disambiguateProject('Dashboard v2', projects, 'Dashboard v2 bauen');
    expect(result.action).toBe('create_version');
    expect(result.existingId).toBe('ent-dash');
    expect(result.version).toBe('v2');
  });

  it('creates new project when no match found', () => {
    const projects = [makeProject({ entityId: 'ent-notes2', entityName: 'Notes2' })];
    const result = disambiguateProject('FitnessApp', projects, 'Neue App starten');
    expect(result.action).toBe('create_version');
    expect(result.existingId).toBeUndefined();
  });

  it('creates version when restart signal detected', () => {
    const projects = [
      makeProject({ entityId: 'ent-notes', entityName: 'Notes', status: 'abandoned' }),
    ];
    const result = disambiguateProject('Notes', projects, 'Notes komplett neu bauen als v2');
    expect(result.action).toBe('create_version');
    expect(result.existingId).toBe('ent-notes');
  });
});

describe('detectProjectStatusSignal', () => {
  it('detects deployed status', () => {
    expect(detectProjectStatusSignal('Das Projekt ist jetzt live auf Vercel')).toBe('deployed');
  });

  it('detects in_progress from work signals', () => {
    expect(detectProjectStatusSignal('Ich arbeite gerade am Auth-System')).toBe('in_progress');
  });

  it('detects paused status', () => {
    expect(detectProjectStatusSignal('Das Projekt ist erstmal pausiert')).toBe('paused');
  });

  it('returns null for no status signal', () => {
    expect(detectProjectStatusSignal('Die Sonne scheint heute')).toBeNull();
  });

  it('detects abandoned status', () => {
    expect(detectProjectStatusSignal('Das Projekt habe ich aufgegeben')).toBe('abandoned');
  });
});
