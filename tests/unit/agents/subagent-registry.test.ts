import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  abortSubagentRun,
  attachSubagentRuntime,
  completeSubagentRun,
  countActiveSubagentRuns,
  createSubagentRun,
  failSubagentRun,
  listSubagentRunsForConversation,
  markSubagentRunKilled,
  resetSubagentRegistryForTests,
} from '@/server/agents/subagentRegistry';

const CONV_ID = 'conv-test-1';
const USER_ID = 'user-test-1';
const AGENT_ID = 'agent-test-1';

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `subagent-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function makeRunInput(
  overrides: Record<string, unknown> = {},
): Parameters<typeof createSubagentRun>[0] {
  return {
    requesterConversationId: CONV_ID,
    requesterUserId: USER_ID,
    agentId: AGENT_ID,
    task: 'Do the thing',
    ...overrides,
  } as Parameters<typeof createSubagentRun>[0];
}

describe('subagentRegistry', () => {
  let storePath: string;
  const createdFiles: string[] = [];

  beforeEach(() => {
    storePath = tmpStorePath();
    createdFiles.push(storePath);
    process.env.SUBAGENT_RUNS_STORE_PATH = storePath;
    resetSubagentRegistryForTests();
  });

  afterEach(() => {
    delete process.env.SUBAGENT_RUNS_STORE_PATH;
    for (const f of createdFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    createdFiles.length = 0;
  });

  describe('readStore — file missing', () => {
    it('returns empty runs when store file does not exist', () => {
      // Store file doesn't exist yet, ensureLoaded should start fresh
      const run = createSubagentRun(makeRunInput());
      expect(run.status).toBe('running');
    });
  });

  describe('readStore — bad JSON', () => {
    it('returns empty runs when store file contains invalid JSON', () => {
      fs.writeFileSync(storePath, 'not valid json', 'utf-8');
      // Should not throw; start fresh
      const run = createSubagentRun(makeRunInput());
      expect(run.status).toBe('running');
    });
  });

  describe('readStore — wrong version', () => {
    it('returns empty runs when store has wrong version number', () => {
      fs.writeFileSync(storePath, JSON.stringify({ version: 99, runs: [] }), 'utf-8');
      const run = createSubagentRun(makeRunInput());
      expect(run.status).toBe('running');
    });
  });

  describe('readStore — missing runs array', () => {
    it('returns empty runs when store has no runs array', () => {
      fs.writeFileSync(storePath, JSON.stringify({ version: 1, runs: null }), 'utf-8');
      const run = createSubagentRun(makeRunInput());
      expect(run.status).toBe('running');
    });
  });

  describe('readStore — malformed record filtering', () => {
    it('filters out records with missing required fields', () => {
      const validRecord = {
        runId: 'run-valid',
        requesterConversationId: CONV_ID,
        requesterUserId: USER_ID,
        agentId: AGENT_ID,
        task: 'Task',
        status: 'completed',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };
      const invalidRecord = {
        runId: 'run-invalid',
        // missing requesterConversationId, task, status etc.
        agentId: AGENT_ID,
      };
      fs.writeFileSync(
        storePath,
        JSON.stringify({ version: 1, runs: [validRecord, invalidRecord] }),
        'utf-8',
      );

      const { active, recent } = listSubagentRunsForConversation(CONV_ID, 60);
      // only the valid completed record appears in recent
      expect(active).toHaveLength(0);
      expect(recent).toHaveLength(1);
      expect(recent[0].runId).toBe('run-valid');
    });
  });

  describe('ensureLoaded — stale running records recovered as killed', () => {
    it('marks persisted running records as killed on load', () => {
      const staleRecord = {
        runId: 'run-stale',
        requesterConversationId: CONV_ID,
        requesterUserId: USER_ID,
        agentId: AGENT_ID,
        task: 'Stale task',
        status: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(storePath, JSON.stringify({ version: 1, runs: [staleRecord] }), 'utf-8');

      const { active, recent } = listSubagentRunsForConversation(CONV_ID, 60);
      expect(active).toHaveLength(0);
      // The stale run should show as killed in recent (it ended)
      expect(recent).toHaveLength(1);
      expect(recent[0].status).toBe('killed');
      expect(recent[0].error).toContain('restart');
    });
  });

  describe('updateRun on unknown ID', () => {
    it('completeSubagentRun returns null for unknown runId', () => {
      createSubagentRun(makeRunInput()); // initialise store
      const result = completeSubagentRun('non-existent-run-id');
      expect(result).toBeNull();
    });

    it('failSubagentRun returns null for unknown runId', () => {
      createSubagentRun(makeRunInput());
      const result = failSubagentRun('non-existent-run-id', 'some error');
      expect(result).toBeNull();
    });

    it('markSubagentRunKilled returns null for unknown runId', () => {
      createSubagentRun(makeRunInput());
      const result = markSubagentRunKilled('non-existent-run-id');
      expect(result).toBeNull();
    });
  });

  describe('failSubagentRun — killed status preserved', () => {
    it('keeps status as killed if run was already killed', () => {
      const run = createSubagentRun(makeRunInput());
      markSubagentRunKilled(run.runId, 'killed first');
      const result = failSubagentRun(run.runId, 'new error');
      expect(result?.status).toBe('killed');
    });

    it('sets status to error if run was running', () => {
      const run = createSubagentRun(makeRunInput());
      const result = failSubagentRun(run.runId, 'execution error');
      expect(result?.status).toBe('error');
    });
  });

  describe('abortSubagentRun', () => {
    it('returns false and marks killed when no runtime attached', () => {
      const run = createSubagentRun(makeRunInput());
      const aborted = abortSubagentRun(run.runId, 'stopped');
      expect(aborted).toBe(false);
      const { recent } = listSubagentRunsForConversation(CONV_ID, 60);
      expect(recent[0].status).toBe('killed');
    });

    it('returns true and aborts controller when runtime is attached', () => {
      const run = createSubagentRun(makeRunInput());
      const abortController = new AbortController();
      attachSubagentRuntime(run.runId, { abortController });

      const aborted = abortSubagentRun(run.runId, 'user cancelled');
      expect(aborted).toBe(true);
      expect(abortController.signal.aborted).toBe(true);

      const { recent } = listSubagentRunsForConversation(CONV_ID, 60);
      expect(recent[0].status).toBe('killed');
    });
  });

  describe('listSubagentRunsForConversation', () => {
    it('returns active runs in active, finished runs in recent', () => {
      const run1 = createSubagentRun(makeRunInput());
      const run2 = createSubagentRun(makeRunInput());
      completeSubagentRun(run2.runId);

      const { active, recent } = listSubagentRunsForConversation(CONV_ID, 60);
      expect(active).toHaveLength(1);
      expect(active[0].runId).toBe(run1.runId);
      expect(recent).toHaveLength(1);
      expect(recent[0].runId).toBe(run2.runId);
    });

    it('clamps recentMinutes to minimum 1 when 0 is passed', () => {
      const run = createSubagentRun(makeRunInput());
      completeSubagentRun(run.runId);
      // recentMinutes=0 → Math.max(1, Math.floor(0)) = 1 minute cutoff
      // Just completed, so should appear in recent
      const { recent } = listSubagentRunsForConversation(CONV_ID, 0);
      expect(recent).toHaveLength(1);
    });

    it('excludes runs outside the recent window', () => {
      const oldRecord = {
        runId: 'run-old',
        requesterConversationId: CONV_ID,
        requesterUserId: USER_ID,
        agentId: AGENT_ID,
        task: 'Old task',
        status: 'completed',
        createdAt: new Date(Date.now() - 200 * 60_000).toISOString(),
        startedAt: new Date(Date.now() - 200 * 60_000).toISOString(),
        endedAt: new Date(Date.now() - 200 * 60_000).toISOString(),
      };
      fs.writeFileSync(storePath, JSON.stringify({ version: 1, runs: [oldRecord] }), 'utf-8');

      // 60 minute window — old run ended 200 minutes ago
      const { recent } = listSubagentRunsForConversation(CONV_ID, 60);
      expect(recent).toHaveLength(0);
    });

    it('only returns runs for the given conversation', () => {
      createSubagentRun(makeRunInput({ requesterConversationId: 'other-conv' }));
      const myRun = createSubagentRun(makeRunInput());

      const { active } = listSubagentRunsForConversation(CONV_ID, 60);
      expect(active).toHaveLength(1);
      expect(active[0].runId).toBe(myRun.runId);
    });
  });

  describe('countActiveSubagentRuns', () => {
    it('counts only running runs for the given conversation', () => {
      const run1 = createSubagentRun(makeRunInput());
      const run2 = createSubagentRun(makeRunInput());
      completeSubagentRun(run2.runId);
      createSubagentRun(makeRunInput({ requesterConversationId: 'other-conv' }));

      expect(countActiveSubagentRuns(CONV_ID)).toBe(1);
      expect(countActiveSubagentRuns('other-conv')).toBe(1);
    });

    it('returns 0 when no active runs exist', () => {
      expect(countActiveSubagentRuns(CONV_ID)).toBe(0);
    });
  });
});
