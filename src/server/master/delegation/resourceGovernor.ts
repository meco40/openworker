export class DelegationResourceGovernor {
  private activeGlobal = 0;
  private readonly activeByCapability = new Map<string, number>();

  constructor(private readonly maxConcurrent: number) {}

  getActiveGlobal(): number {
    return this.activeGlobal;
  }

  getActiveForCapability(capability: string): number {
    return this.activeByCapability.get(capability) ?? 0;
  }

  tryAcquire(capability: string): boolean {
    if (this.activeGlobal >= this.maxConcurrent) return false;
    this.activeGlobal += 1;
    this.activeByCapability.set(capability, (this.activeByCapability.get(capability) ?? 0) + 1);
    return true;
  }

  release(capability: string): void {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    const next = Math.max(0, (this.activeByCapability.get(capability) ?? 1) - 1);
    if (next === 0) this.activeByCapability.delete(capability);
    else this.activeByCapability.set(capability, next);
  }
}
