/**
 * File Reveal API
 * Opens a file's location in Finder (macOS) or Explorer (Windows)
 */

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveAllowedExistingPath } from '@/server/security/fileAccess';
import { withUserContext } from '../../_shared/withUserContext';

const execFileAsync = promisify(execFile);

export const POST = withUserContext(async ({ request }) => {
  try {
    const body = (await request.json().catch(() => null)) as { filePath?: string } | null;
    const filePath = typeof body?.filePath === 'string' ? body.filePath : '';

    if (!filePath) {
      return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
    }

    const resolvedPathResult = resolveAllowedExistingPath(filePath);
    if (!resolvedPathResult.ok) {
      console.warn(`[FILE] Blocked access to: ${filePath}`);
      return NextResponse.json(
        { error: resolvedPathResult.error },
        { status: resolvedPathResult.status },
      );
    }
    const normalizedPath = resolvedPathResult.resolvedPath;

    // Open in Finder (macOS) - reveal the file
    const platform = process.platform;
    if (platform === 'darwin') {
      await execFileAsync('open', ['-R', normalizedPath]);
    } else if (platform === 'win32') {
      await execFileAsync('explorer.exe', [`/select,${normalizedPath}`]);
    } else {
      await execFileAsync('xdg-open', [path.dirname(normalizedPath)]);
    }

    console.log(`[FILE] Revealed: ${normalizedPath}`);
    return NextResponse.json({ success: true, path: normalizedPath });
  } catch (error) {
    console.error('[FILE] Error revealing file:', error);
    return NextResponse.json({ error: 'Failed to reveal file' }, { status: 500 });
  }
});
