import { NextResponse } from 'next/server';
import { testProviderAccountConnectivity } from '../../../../../src/server/model-hub/connectivity';
import {
  getModelHubEncryptionKey,
  getModelHubService,
} from '../../../../../src/server/model-hub/runtime';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

interface TestAllRequestBody {
  modelByAccountId?: Record<string, string>;
}

interface ConnectivityResultItem {
  accountId: string;
  providerId: string;
  label: string;
  ok: boolean;
  message: string;
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as TestAllRequestBody;
    const modelByAccountId = body.modelByAccountId || {};

    const service = getModelHubService();
    const encryptionKey = getModelHubEncryptionKey();
    const accounts = service.listAccounts();
    const results: ConnectivityResultItem[] = [];

    for (const accountView of accounts) {
      const account = await service.getUsableAccountById(accountView.id, encryptionKey);
      if (!account) continue;

      const modelCandidate = modelByAccountId[account.id];
      const model = typeof modelCandidate === 'string' ? modelCandidate.trim() : undefined;
      const connectivity = await testProviderAccountConnectivity(account, encryptionKey, {
        model,
      });
      service.updateHealth(account.id, connectivity.ok, connectivity.message);

      results.push({
        accountId: account.id,
        providerId: account.providerId,
        label: account.label,
        ok: connectivity.ok,
        message: connectivity.message,
      });
    }

    const successCount = results.filter((item) => item.ok).length;
    return NextResponse.json({
      ok: true,
      total: results.length,
      successCount,
      failureCount: results.length - successCount,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bulk connectivity test failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
