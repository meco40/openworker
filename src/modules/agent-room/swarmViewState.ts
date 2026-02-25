export const SWARM_LAYOUT_MODES = ['split', 'chat', 'board'] as const;
export type SwarmLayoutMode = (typeof SWARM_LAYOUT_MODES)[number];

export const SWARM_OUTPUT_TABS = [
  'solution_artifact',
  'logic_graph',
  'history',
  'conflict_radar',
] as const;
export type SwarmOutputTab = (typeof SWARM_OUTPUT_TABS)[number];

export function isSwarmLayoutMode(value: string): value is SwarmLayoutMode {
  return (SWARM_LAYOUT_MODES as readonly string[]).includes(value);
}

export function isSwarmOutputTab(value: string): value is SwarmOutputTab {
  return (SWARM_OUTPUT_TABS as readonly string[]).includes(value);
}

