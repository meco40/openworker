/**
 * File Preview API
 * Serves local files for preview (HTML only for security)
 */

import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolveAllowedExistingPath } from '@/server/security/fileAccess';
import { withUserContext } from '../../_shared/withUserContext';

export const GET = withUserContext(async ({ request }) => {
  const filePath = new URL(request.url).searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  // Only allow HTML files
  const loweredFilePath = filePath.toLowerCase();
  if (!loweredFilePath.endsWith('.html') && !loweredFilePath.endsWith('.htm')) {
    return NextResponse.json({ error: 'Only HTML files can be previewed' }, { status: 400 });
  }

  const resolvedPathResult = resolveAllowedExistingPath(filePath);
  if (!resolvedPathResult.ok) {
    return NextResponse.json(
      { error: resolvedPathResult.error },
      { status: resolvedPathResult.status },
    );
  }
  const normalizedPath = resolvedPathResult.resolvedPath;

  try {
    const content = readFileSync(normalizedPath, 'utf-8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[FILE] Error reading file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
});
