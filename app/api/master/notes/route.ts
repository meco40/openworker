import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface NotesBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  noteId?: string;
  title?: string;
  content?: string;
  tags?: string[];
}

export async function GET(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scope = resolveScopeFromRequest(request, userId);
    const notes = getMasterRepository().listNotes(scope);
    return NextResponse.json({ ok: true, notes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list notes';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as NotesBody;
    if (!body.title || !body.content) {
      return NextResponse.json(
        { ok: false, error: 'title and content are required' },
        { status: 400 },
      );
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const note = getMasterRepository().createNote(scope, {
      title: body.title,
      content: body.content,
      tags: body.tags || [],
    });
    return NextResponse.json({ ok: true, note }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create note';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as NotesBody;
    if (!body.noteId) {
      return NextResponse.json({ ok: false, error: 'noteId is required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const note = getMasterRepository().updateNote(scope, body.noteId, {
      title: body.title,
      content: body.content,
      tags: body.tags,
    });
    if (!note) {
      return NextResponse.json({ ok: false, error: 'Note not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, note });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to patch note';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as NotesBody;
    if (!body.noteId) {
      return NextResponse.json({ ok: false, error: 'noteId is required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const deleted = getMasterRepository().deleteNote(scope, body.noteId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete note';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
