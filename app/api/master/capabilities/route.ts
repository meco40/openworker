import { NextResponse } from 'next/server';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { getMasterRepository } from '@/server/master/runtime';
import { buildCapabilityInventory } from '@/server/master/capabilities/inventory';
import { createCapabilityApprenticeshipProposal } from '@/server/master/capabilities/apprenticeship';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CapabilitiesBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  capability?: string;
  reason?: string;
  apiReference?: string;
  authModel?: string;
  scopes?: string[];
  rateLimit?: string;
  fallbackPlan?: string;
}

export async function GET(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scope = resolveScopeFromRequest(request, userId);
    const inventory = buildCapabilityInventory(getMasterRepository(), scope);
    const proposals = getMasterRepository().listCapabilityProposals(scope);
    return NextResponse.json({ ok: true, inventory, proposals });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load capabilities';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as CapabilitiesBody;
    if (!body.capability || !body.reason) {
      return NextResponse.json(
        { ok: false, error: 'capability and reason are required' },
        { status: 400 },
      );
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const proposal = createCapabilityApprenticeshipProposal(getMasterRepository(), scope, {
      capability: body.capability,
      reason: body.reason,
      apiReference: body.apiReference || 'UNCONFIRMED',
      authModel: body.authModel || 'oauth2',
      scopes: body.scopes || ['read'],
      rateLimit: body.rateLimit || 'UNCONFIRMED',
      fallbackPlan: body.fallbackPlan || 'Continue with existing capabilities.',
    });
    return NextResponse.json({ ok: true, proposal }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create capability proposal';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
