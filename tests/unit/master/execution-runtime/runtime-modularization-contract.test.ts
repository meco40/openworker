import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('master execution runtime modularization contract', () => {
  it('keeps orchestration and capability execution in dedicated modules', () => {
    const runtimeSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/master/execution/runtime/masterExecutionRuntime.ts'),
      'utf8',
    );
    const flowSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/master/execution/runtime/executionFlow.ts'),
      'utf8',
    );

    expect(runtimeSource).toContain('executeMasterRunFlow');
    expect(runtimeSource).not.toContain('dispatchSkill(');
    expect(flowSource).toContain("status: 'AWAITING_APPROVAL'");
    expect(flowSource).toContain("status: 'REFINING'");
    expect(flowSource).toContain('verifyExecutionResult');
  });

  it('keeps planner and executor split between plan and capability modules', () => {
    const planSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/master/execution/runtime/executionPlan.ts'),
      'utf8',
    );
    const capabilitySource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/master/execution/runtime/capabilityExecutor.ts'),
      'utf8',
    );

    expect(planSource).toContain('buildExecutionPlanWithModel');
    expect(planSource).toContain('buildFallbackExecutionPlan');
    expect(capabilitySource).toContain('executeCapabilityTask');
    expect(capabilitySource).toContain('runTool({');
    expect(capabilitySource).toContain("toolName: 'web_search'");
    expect(capabilitySource).toContain("toolName: 'write'");
  });
});
