import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('planning controller completion idempotence contract', () => {
  it('guards onPlanningComplete with a ref and removes legacy onSpecLocked', () => {
    const source = read('src/components/planning/usePlanningTabController.ts');

    expect(source).toContain('const completionCallbackSentRef = useRef(false);');
    expect(source).toContain('if (completionCallbackSentRef.current) return;');
    expect(source).toContain('completionCallbackSentRef.current = true;');
    expect(source).toContain('await onPlanningComplete({ taskId, dispatchError });');
    expect(source).not.toContain('onSpecLocked');
  });
});
