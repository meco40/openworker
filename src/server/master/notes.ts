import type { MasterRepository } from '@/server/master/repository';
import type { MasterNote, WorkspaceScope } from '@/server/master/types';

export class MasterNotesService {
  constructor(private readonly repo: MasterRepository) {}

  create(
    scope: WorkspaceScope,
    input: { title: string; content: string; tags?: string[] },
  ): MasterNote {
    return this.repo.createNote(scope, {
      title: input.title,
      content: input.content,
      tags: input.tags || [],
    });
  }

  list(scope: WorkspaceScope): MasterNote[] {
    return this.repo.listNotes(scope);
  }
}
