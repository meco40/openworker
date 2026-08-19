#!/usr/bin/env node
/**
 * Private helper for the scheduler process-boundary failure drill.
 * It claims the isolated automation lease and stays alive until the parent
 * terminates it, modelling a real scheduler process rather than a second
 * in-process service instance.
 */

import { getAutomationService } from '@/server/automation/runtime';

const owner = process.argv[2];
const ttlMs = Number(process.argv[3] || 250);
if (!owner) {
  console.error('owner is required');
  process.exit(2);
}

const claimed = getAutomationService().acquireLease(owner, ttlMs);
process.stdout.write(`${JSON.stringify({ claimed, owner })}\n`);
if (!claimed) process.exit(1);

const keepAlive = setInterval(() => {}, 1_000);
keepAlive.unref();
