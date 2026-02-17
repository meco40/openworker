import crypto from 'node:crypto';
import { toApprovalRule } from '../workerRowMappers';
import type {
  ApprovalRule,
} from '../workerTypes';
import { BaseRepository } from './baseRepository';

/**
 * Repository for approval rule-related operations.
 */
export class ApprovalRuleRepository extends BaseRepository {
  
  addApprovalRule(commandPattern: string): void {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO worker_approval_rules (id, command_pattern, created_at)
        VALUES (?, ?, ?)
      `,
      )
      .run(id, commandPattern, now);
  }

  removeApprovalRule(id: string): void {
    this.db.prepare('DELETE FROM worker_approval_rules WHERE id = ?').run(id);
  }

  isCommandApproved(command: string): boolean {
    // Check exact match first
    const exact = this.db
      .prepare(`SELECT 1 FROM worker_approval_rules WHERE command_pattern = ?`)
      .get(command);
    if (exact) return true;

    // Check glob patterns (simple prefix matching with *)
    const rules = this.db
      .prepare(`SELECT command_pattern FROM worker_approval_rules WHERE command_pattern LIKE '%*%'`)
      .all() as Array<Record<string, unknown>>;

    for (const rule of rules) {
      const pattern = rule.command_pattern as string;
      const prefix = pattern.replace(/\*.*$/, '');
      if (command.startsWith(prefix)) return true;
    }

    return false;
  }

  listApprovalRules(): ApprovalRule[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_approval_rules ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toApprovalRule);
  }
}
