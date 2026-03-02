import { NextResponse } from 'next/server';
import { getMemoryService } from '@/server/memory/runtime';
import { getModelHubService } from '@/server/model-hub/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getKnowledgeRepository } from '@/server/knowledge/runtime';
import { MEMORY_PERSONA_TYPES, type MemoryPersonaType } from '@/server/personas/personaTypes';
import { unpairPersonaTelegram } from '@/server/telegram/personaTelegramPairing';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface PersonaIdParams {
  id: string;
}

function isPreferredModelAvailable(preferredModelId: string): boolean {
  const modelHub = getModelHubService();
  const activePipeline = modelHub.listPipeline('p1');
  return activePipeline.some(
    (entry) => entry.status === 'active' && entry.modelName === preferredModelId,
  );
}

function isValidModelHubProfileId(value: string): boolean {
  if (!value.trim()) return false;
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value.trim());
}

// ─── GET /api/personas/[id] ─── Get a persona with all files
export const GET = withUserContext<PersonaIdParams>(async ({ userContext, params }) => {
  try {
    const { id } = params;
    const repo = getPersonaRepository();
    const persona = repo.getPersonaWithFiles(id);

    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, persona });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

// ─── PUT /api/personas/[id] ─── Update persona metadata
// Body: { name?, emoji?, vibe? }
export const PUT = withUserContext<PersonaIdParams>(async ({ request, userContext, params }) => {
  try {
    const { id } = params;
    const repo = getPersonaRepository();

    // Verify ownership
    const existing = repo.getPersona(id);
    if (!existing || existing.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json()) as {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
      modelHubProfileId?: string | null;
      memoryPersonaType?: string;
      isAutonomous?: boolean;
      maxToolCalls?: number;
    };

    const updates: {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
      modelHubProfileId?: string | null;
      memoryPersonaType?: MemoryPersonaType;
      isAutonomous?: boolean;
      maxToolCalls?: number;
    } = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (updates.name !== undefined && updates.name.length === 0) {
      return NextResponse.json({ ok: false, error: 'name must not be empty' }, { status: 400 });
    }
    if (body.emoji !== undefined) updates.emoji = body.emoji.trim();
    if (body.vibe !== undefined) updates.vibe = body.vibe.trim();
    if (body.preferredModelId !== undefined) {
      if (body.preferredModelId === null) {
        updates.preferredModelId = null;
      } else if (typeof body.preferredModelId === 'string' && body.preferredModelId.trim().length) {
        const normalizedModelId = body.preferredModelId.trim();
        if (!isPreferredModelAvailable(normalizedModelId)) {
          return NextResponse.json(
            { ok: false, error: `preferredModelId "${normalizedModelId}" is not available.` },
            { status: 400 },
          );
        }
        updates.preferredModelId = normalizedModelId;
      } else {
        return NextResponse.json(
          { ok: false, error: 'preferredModelId must be a non-empty string or null' },
          { status: 400 },
        );
      }
    }
    if (body.modelHubProfileId !== undefined) {
      if (body.modelHubProfileId === null) {
        updates.modelHubProfileId = null;
      } else if (
        typeof body.modelHubProfileId === 'string' &&
        isValidModelHubProfileId(body.modelHubProfileId)
      ) {
        updates.modelHubProfileId = body.modelHubProfileId.trim();
      } else {
        return NextResponse.json(
          {
            ok: false,
            error:
              'modelHubProfileId must be a non-empty string (letters, numbers, ".", "_" or "-") or null',
          },
          { status: 400 },
        );
      }
    }
    if (body.memoryPersonaType !== undefined) {
      if (!MEMORY_PERSONA_TYPES.includes(body.memoryPersonaType as MemoryPersonaType)) {
        return NextResponse.json(
          {
            ok: false,
            error: `Invalid memoryPersonaType. Allowed: ${MEMORY_PERSONA_TYPES.join(', ')}`,
          },
          { status: 400 },
        );
      }
      updates.memoryPersonaType = body.memoryPersonaType as MemoryPersonaType;
    }
    if (body.isAutonomous !== undefined) {
      updates.isAutonomous = Boolean(body.isAutonomous);
    }
    if (body.maxToolCalls !== undefined) {
      const num = Math.floor(Number(body.maxToolCalls));
      if (!Number.isFinite(num) || num < 3 || num > 500) {
        return NextResponse.json(
          { ok: false, error: 'maxToolCalls must be an integer between 3 and 500' },
          { status: 400 },
        );
      }
      updates.maxToolCalls = num;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ ok: false, error: 'No updates provided' }, { status: 400 });
    }

    repo.updatePersona(id, updates);
    const updated = repo.getPersonaWithFiles(id);
    return NextResponse.json({ ok: true, persona: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (/slug already exists/i.test(message)) {
      return NextResponse.json({ ok: false, error: message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

// ─── DELETE /api/personas/[id] ─── Delete a persona
export const DELETE = withUserContext<PersonaIdParams>(async ({ userContext, params }) => {
  try {
    const { id } = params;
    const repo = getPersonaRepository();

    // Verify ownership
    const existing = repo.getPersona(id);
    if (!existing || existing.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const messageService = getMessageService();
    const messageRepository = getMessageRepository();
    const personaConversations =
      typeof messageRepository.listConversationsByPersona === 'function'
        ? messageRepository.listConversationsByPersona(id, userContext.userId, 10_000)
        : messageService
            .listConversations(userContext.userId, 10_000)
            .filter((conversation) => conversation.personaId === id);
    for (const conversation of personaConversations) {
      messageService.deleteConversation(conversation.id, userContext.userId);
    }

    getKnowledgeRepository().deleteKnowledgeByScope(userContext.userId, id);
    await unpairPersonaTelegram(id);
    await getMemoryService().deleteByPersona(id, userContext.userId);
    repo.deletePersona(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
