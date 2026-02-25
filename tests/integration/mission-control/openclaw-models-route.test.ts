import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control OpenClaw models route', () => {
  let tempDir = '';
  let previousModelHubDbPath: string | undefined;
  let previousModelHubKey: string | undefined;

  beforeEach(() => {
    vi.resetModules();

    previousModelHubDbPath = process.env.MODEL_HUB_DB_PATH;
    previousModelHubKey = process.env.MODEL_HUB_ENCRYPTION_KEY;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-openclaw-models-'));
    process.env.MODEL_HUB_DB_PATH = path.join(tempDir, 'model-hub.db');
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    if (previousModelHubDbPath === undefined) {
      delete process.env.MODEL_HUB_DB_PATH;
    } else {
      process.env.MODEL_HUB_DB_PATH = previousModelHubDbPath;
    }

    if (previousModelHubKey === undefined) {
      delete process.env.MODEL_HUB_ENCRYPTION_KEY;
    } else {
      process.env.MODEL_HUB_ENCRYPTION_KEY = previousModelHubKey;
    }

    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep sqlite handles open across module singletons in test runtime.
      }
      tempDir = '';
    }
  });

  it('returns 200 with fallback models when standalone OpenClaw config is missing', async () => {
    const { GET } = await import('../../../app/api/openclaw/models/route');

    const response = await GET();
    const payload = (await response.json()) as {
      defaultModel?: string;
      availableModels?: string[];
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(Array.isArray(payload.availableModels)).toBe(true);
    expect(payload.availableModels && payload.availableModels.length).toBeGreaterThan(0);
  });
});
