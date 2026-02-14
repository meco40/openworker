export interface WorkerTaskDeliverableView {
  id: string;
  name: string;
  source: 'deliverable' | 'legacy-artifact';
  mimeType: string | null;
  createdAt: string;
}

export function normalizeTaskDeliverables(
  items: WorkerTaskDeliverableView[],
): WorkerTaskDeliverableView[] {
  const byId = new Map<string, WorkerTaskDeliverableView>();
  for (const item of items) {
    byId.set(item.id, item);
  }

  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
