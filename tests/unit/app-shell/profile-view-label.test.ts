import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AppShell profile view label', () => {
  it('uses single-user profile naming for the profile view boundary', () => {
    const filePath = path.join(
      process.cwd(),
      'src/modules/app-shell/components/AppShellViewContent.tsx',
    );
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('<ViewErrorBoundary label="Operator Profile">');
    expect(content).not.toContain('<ViewErrorBoundary label="SaaS Identity">');
  });
});
