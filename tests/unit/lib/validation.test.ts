import { describe, expect, it } from 'vitest';
import {
  CreateActivitySchema,
  CreateAgentSchema,
  CreateDeliverableSchema,
  CreateTaskSchema,
  CreateWorkspaceSchema,
  UpdateAgentSchema,
  UpdateTaskSchema,
  UpdateWorkspaceSchema,
} from '@/lib/validation';

describe('CreateTaskSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Test Task',
      description: 'A test task description',
      status: 'inbox',
      priority: 'high',
      assigned_agent_id: '123e4567-e89b-12d3-a456-426614174000',
      created_by_agent_id: '123e4567-e89b-12d3-a456-426614174001',
      business_id: 'business-123',
      workspace_id: 'workspace-456',
      due_date: '2026-03-15',
    });

    expect(result.success).toBe(true);
  });

  it('accepts minimal valid input with only title', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Minimal Task',
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = CreateTaskSchema.safeParse({
      description: 'No title provided',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('title');
    }
  });

  it('rejects empty title', () => {
    const result = CreateTaskSchema.safeParse({
      title: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects title longer than 500 characters', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'a'.repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it('accepts title at exactly 500 characters', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'a'.repeat(500),
    });

    expect(result.success).toBe(true);
  });

  it('rejects description longer than 10000 characters', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Test',
      description: 'a'.repeat(10001),
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid status value', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Test',
      status: 'invalid_status',
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid priority value', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Test',
      priority: 'critical',
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID for assigned_agent_id', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Test',
      assigned_agent_id: 'not-a-uuid',
    });

    expect(result.success).toBe(false);
  });

  it('accepts null for assigned_agent_id', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Test',
      assigned_agent_id: null,
    });

    expect(result.success).toBe(true);
  });
});

describe('UpdateTaskSchema', () => {
  it('accepts partial updates', () => {
    const result = UpdateTaskSchema.safeParse({
      title: 'Updated Title',
      status: 'done',
    });

    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = UpdateTaskSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('rejects empty title when provided', () => {
    const result = UpdateTaskSchema.safeParse({
      title: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects title longer than 500 characters', () => {
    const result = UpdateTaskSchema.safeParse({
      title: 'a'.repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid status', () => {
    const result = UpdateTaskSchema.safeParse({
      status: 'unknown',
    });

    expect(result.success).toBe(false);
  });

  it('accepts null for assigned_agent_id', () => {
    const result = UpdateTaskSchema.safeParse({
      assigned_agent_id: null,
    });

    expect(result.success).toBe(true);
  });
});

describe('CreateActivitySchema', () => {
  it('accepts valid input', () => {
    const result = CreateActivitySchema.safeParse({
      activity_type: 'spawned',
      message: 'Agent spawned for task',
    });

    expect(result.success).toBe(true);
  });

  it('accepts all activity types', () => {
    const activityTypes = ['spawned', 'updated', 'completed', 'file_created', 'status_changed'];

    for (const type of activityTypes) {
      const result = CreateActivitySchema.safeParse({
        activity_type: type,
        message: 'Test message',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing activity_type', () => {
    const result = CreateActivitySchema.safeParse({
      message: 'Test message',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing message', () => {
    const result = CreateActivitySchema.safeParse({
      activity_type: 'spawned',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty message', () => {
    const result = CreateActivitySchema.safeParse({
      activity_type: 'spawned',
      message: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects message longer than 5000 characters', () => {
    const result = CreateActivitySchema.safeParse({
      activity_type: 'spawned',
      message: 'a'.repeat(5001),
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid activity_type', () => {
    const result = CreateActivitySchema.safeParse({
      activity_type: 'invalid_type',
      message: 'Test',
    });

    expect(result.success).toBe(false);
  });

  it('accepts optional agent_id as UUID', () => {
    const result = CreateActivitySchema.safeParse({
      activity_type: 'spawned',
      message: 'Test',
      agent_id: '123e4567-e89b-12d3-a456-426614174000',
    });

    expect(result.success).toBe(true);
  });
});

describe('CreateDeliverableSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = CreateDeliverableSchema.safeParse({
      deliverable_type: 'file',
      title: 'Implementation File',
      path: '/src/implementation.ts',
      description: 'Main implementation',
    });

    expect(result.success).toBe(true);
  });

  it('accepts all deliverable types', () => {
    const deliverableTypes = ['file', 'url', 'artifact'];

    for (const type of deliverableTypes) {
      const result = CreateDeliverableSchema.safeParse({
        deliverable_type: type,
        title: 'Test',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing deliverable_type', () => {
    const result = CreateDeliverableSchema.safeParse({
      title: 'Test',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = CreateDeliverableSchema.safeParse({
      deliverable_type: 'file',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = CreateDeliverableSchema.safeParse({
      deliverable_type: 'file',
      title: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid deliverable_type', () => {
    const result = CreateDeliverableSchema.safeParse({
      deliverable_type: 'document',
      title: 'Test',
    });

    expect(result.success).toBe(false);
  });
});

describe('CreateWorkspaceSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'My Workspace',
      description: 'A workspace for testing',
      icon: '📊',
    });

    expect(result.success).toBe(true);
  });

  it('accepts minimal valid input with only name', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'Minimal Workspace',
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = CreateWorkspaceSchema.safeParse({
      description: 'No name',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only name', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: '   ',
    });

    expect(result.success).toBe(false);
  });

  it('rejects name longer than 120 characters', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'a'.repeat(121),
    });

    expect(result.success).toBe(false);
  });

  it('accepts name at exactly 120 characters', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'a'.repeat(120),
    });

    expect(result.success).toBe(true);
  });

  it('rejects description longer than 2000 characters', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'Test',
      description: 'a'.repeat(2001),
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty icon when provided', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'Test',
      icon: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects icon longer than 16 characters', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: 'Test',
      icon: 'a'.repeat(17),
    });

    expect(result.success).toBe(false);
  });

  it('trims whitespace from name', () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: '  Trimmed Name  ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Trimmed Name');
    }
  });
});

describe('UpdateWorkspaceSchema', () => {
  it('accepts partial updates', () => {
    const result = UpdateWorkspaceSchema.safeParse({
      name: 'Updated Name',
    });

    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = UpdateWorkspaceSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('rejects empty name when provided', () => {
    const result = UpdateWorkspaceSchema.safeParse({
      name: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects name longer than 120 characters', () => {
    const result = UpdateWorkspaceSchema.safeParse({
      name: 'a'.repeat(121),
    });

    expect(result.success).toBe(false);
  });
});

describe('CreateAgentSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Code Assistant',
      role: 'Software Developer',
      description: 'An AI coding assistant',
      avatar_emoji: '🤖',
      is_master: false,
      workspace_id: 'workspace-123',
      soul_md: '# Soul\n\nInstructions',
      user_md: '# User\n\nPreferences',
      agents_md: '# Agents\n\nCommunication',
      model: 'claude-3-sonnet',
    });

    expect(result.success).toBe(true);
  });

  it('accepts minimal valid input with name and role', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Minimal Agent',
      role: 'Assistant',
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = CreateAgentSchema.safeParse({
      role: 'Assistant',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing role', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Agent',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = CreateAgentSchema.safeParse({
      name: '',
      role: 'Assistant',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty role', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Agent',
      role: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects name longer than 120 characters', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'a'.repeat(121),
      role: 'Assistant',
    });

    expect(result.success).toBe(false);
  });

  it('rejects role longer than 240 characters', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Agent',
      role: 'a'.repeat(241),
    });

    expect(result.success).toBe(false);
  });

  it('rejects description longer than 4000 characters', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Agent',
      role: 'Assistant',
      description: 'a'.repeat(4001),
    });

    expect(result.success).toBe(false);
  });

  it('rejects soul_md longer than 20000 characters', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Agent',
      role: 'Assistant',
      soul_md: 'a'.repeat(20001),
    });

    expect(result.success).toBe(false);
  });

  it('rejects avatar_emoji longer than 16 characters', () => {
    const result = CreateAgentSchema.safeParse({
      name: 'Agent',
      role: 'Assistant',
      avatar_emoji: 'a'.repeat(17),
    });

    expect(result.success).toBe(false);
  });

  it('trims whitespace from name and role', () => {
    const result = CreateAgentSchema.safeParse({
      name: '  Trimmed Agent  ',
      role: '  Assistant  ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Trimmed Agent');
      expect(result.data.role).toBe('Assistant');
    }
  });
});

describe('UpdateAgentSchema', () => {
  it('accepts partial updates', () => {
    const result = UpdateAgentSchema.safeParse({
      name: 'Updated Name',
      status: 'working',
    });

    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = UpdateAgentSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = UpdateAgentSchema.safeParse({
      status: 'busy',
    });

    expect(result.success).toBe(false);
  });

  it('accepts all valid status values', () => {
    const statuses = ['standby', 'working', 'offline'];

    for (const status of statuses) {
      const result = UpdateAgentSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  it('rejects empty name when provided', () => {
    const result = UpdateAgentSchema.safeParse({
      name: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects name longer than 120 characters', () => {
    const result = UpdateAgentSchema.safeParse({
      name: 'a'.repeat(121),
    });

    expect(result.success).toBe(false);
  });
});
