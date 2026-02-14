import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkerRepository } from '../src/server/worker/workerRepository';

function makeMinimalGraph(): string {
  return JSON.stringify({
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'p1', position: { x: 0, y: 0 } },
      { id: 'n2', personaId: 'p2', position: { x: 100, y: 100 } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
  });
}

describe('SqliteWorkerRepository — Orchestra Flows', () => {
  let repo: SqliteWorkerRepository;
  const userId = 'user-test';

  beforeEach(() => {
    repo = new SqliteWorkerRepository(':memory:');
  });

  // ─── Flow Draft CRUD ──────────────────────────────────────

  describe('flow drafts', () => {
    it('creates a flow draft', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Test Flow',
        graphJson: makeMinimalGraph(),
      });
      expect(draft.id).toMatch(/^flow-draft-/);
      expect(draft.name).toBe('Test Flow');
      expect(draft.status).toBe('draft');
      expect(draft.userId).toBe(userId);
    });

    it('retrieves a draft by id', () => {
      const created = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Fetch Me',
        graphJson: makeMinimalGraph(),
      });
      const found = repo.getFlowDraft(created.id, userId);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Fetch Me');
    });

    it('returns null for wrong userId', () => {
      const created = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Private',
        graphJson: makeMinimalGraph(),
      });
      expect(repo.getFlowDraft(created.id, 'other-user')).toBeNull();
    });

    it('updates a draft', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Old Name',
        graphJson: makeMinimalGraph(),
      });
      const updated = repo.updateFlowDraft(draft.id, userId, { name: 'New Name' });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New Name');
    });

    it('rejects update with stale expectedUpdatedAt', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Original',
        graphJson: makeMinimalGraph(),
      });

      // Use a definitely-stale timestamp (1 second in the past)
      const staleTimestamp = new Date(Date.now() - 1000).toISOString();

      const result = repo.updateFlowDraft(
        draft.id,
        userId,
        { name: 'Should Fail' },
        staleTimestamp,
      );
      expect(result).toBeNull();

      // Verify name unchanged
      const current = repo.getFlowDraft(draft.id, userId)!;
      expect(current.name).toBe('Original');
    });

    it('rejects update to published draft', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'To Publish',
        graphJson: makeMinimalGraph(),
      });
      repo.publishFlowDraft(draft.id, userId);

      const result = repo.updateFlowDraft(draft.id, userId, { name: 'Should Fail' });
      expect(result).toBeNull();
    });

    it('deletes a draft', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Delete Me',
        graphJson: makeMinimalGraph(),
      });
      const deleted = repo.deleteFlowDraft(draft.id, userId);
      expect(deleted).toBe(true);
      expect(repo.getFlowDraft(draft.id, userId)).toBeNull();
    });

    it('delete returns false for wrong userId', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Keep',
        graphJson: makeMinimalGraph(),
      });
      expect(repo.deleteFlowDraft(draft.id, 'other-user')).toBe(false);
      expect(repo.getFlowDraft(draft.id, userId)).not.toBeNull();
    });
  });

  // ─── Publishing ───────────────────────────────────────────

  describe('publishing', () => {
    it('publishes a draft', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Publishable',
        graphJson: makeMinimalGraph(),
      });
      const published = repo.publishFlowDraft(draft.id, userId);
      expect(published).not.toBeNull();
      expect(published!.id).toMatch(/^flow-pub-/);
      expect(published!.name).toBe('Publishable');
      expect(published!.version).toBe(1);
      expect(published!.draftId).toBe(draft.id);
    });

    it('marks draft as published after publishing', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Status Check',
        graphJson: makeMinimalGraph(),
      });
      repo.publishFlowDraft(draft.id, userId);
      const updated = repo.getFlowDraft(draft.id, userId)!;
      expect(updated.status).toBe('published');
    });

    it('increments version on republish', () => {
      const draft1 = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Versioned',
        graphJson: makeMinimalGraph(),
      });
      const pub1 = repo.publishFlowDraft(draft1.id, userId)!;
      expect(pub1.version).toBe(1);

      // Create a new draft with the same name and publish it
      const draft2 = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Versioned',
        graphJson: makeMinimalGraph(),
      });
      const pub2 = repo.publishFlowDraft(draft2.id, userId)!;
      expect(pub2.version).toBe(2);
    });

    it('deletes a published flow with no task references', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Deleteable',
        graphJson: makeMinimalGraph(),
      });
      const published = repo.publishFlowDraft(draft.id, userId)!;
      expect(repo.deletePublishedFlow(published.id, userId)).toBe(true);
      expect(repo.getFlowPublished(published.id, userId)).toBeNull();
    });

    it('prevents deletion when task references published flow', () => {
      const draft = repo.createFlowDraft({
        userId,
        workspaceType: 'general',
        name: 'Referenced',
        graphJson: makeMinimalGraph(),
      });
      const published = repo.publishFlowDraft(draft.id, userId)!;

      // Create a task referencing this published flow
      repo.createTask({
        title: 'Linked Task',
        objective: 'Do stuff',
        originPlatform: 'WebChat' as never,
        originConversation: 'conv-1',
        userId,
        flowPublishedId: published.id,
      });

      expect(repo.deletePublishedFlow(published.id, userId)).toBe(false);
      expect(repo.getFlowPublished(published.id, userId)).not.toBeNull();
    });
  });

  // ─── Task flowPublishedId ─────────────────────────────────

  describe('task flowPublishedId', () => {
    it('creates a task with flowPublishedId', () => {
      const task = repo.createTask({
        title: 'Orchestrated',
        objective: 'Run flow',
        originPlatform: 'WebChat' as never,
        originConversation: 'conv-1',
        userId,
        flowPublishedId: 'flow-pub-123',
      });
      expect(task.flowPublishedId).toBe('flow-pub-123');
    });

    it('creates a task without flowPublishedId (defaults to null)', () => {
      const task = repo.createTask({
        title: 'Regular',
        objective: 'No flow',
        originPlatform: 'WebChat' as never,
        originConversation: 'conv-1',
        userId,
      });
      expect(task.flowPublishedId).toBeNull();
    });
  });
});
