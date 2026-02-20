import { spawn } from 'node:child_process';
import { isMethodAllowed } from '../server/gateway/method-scopes';
import { GatewayRpcClient } from './lib/gatewayRpc';

function popOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return undefined;
  const [value] = args.splice(index, 2).slice(1);
  return value;
}

function popFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function printGatewayHelp(): void {
  console.log(`openclaw gateway <command>

Commands:
  run                            Start local web/gateway server
  status [--url <ws-url>]        Call "health" via gateway RPC
  methods [--url <ws-url>]       Print server methods from hello_ok
  call <method> [--params <json>] [--unsafe] [--url <ws-url>]
                                 Call an RPC method in the gateway scope
  chat --message <text> [--conversation <id>] [--persona <id>] [--url <ws-url>]
                                 Send chat.stream and print live deltas
`);
}

async function runGatewayServer(): Promise<never> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  await new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      process.exit(code ?? 0);
    });
    child.once('error', (error) => {
      console.error(`Failed to start gateway server: ${String(error)}`);
      process.exit(1);
    });
    child.once('spawn', () => resolve());
  });

  process.exit(0);
}

async function withGatewayClient<T>(
  args: string[],
  run: (client: GatewayRpcClient, options: { url?: string }) => Promise<T>,
): Promise<T> {
  const url = popOption(args, '--url');
  const client = await GatewayRpcClient.connect({ url });
  try {
    return await run(client, { url });
  } finally {
    client.close();
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object for --params.');
  }
  return parsed as Record<string, unknown>;
}

export async function runGatewayCli(argv: string[]): Promise<void> {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printGatewayHelp();
    return;
  }

  if (command === 'run') {
    await runGatewayServer();
    return;
  }

  if (command === 'status') {
    await withGatewayClient(args, async (client) => {
      const result = await client.request('health', {});
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }

  if (command === 'methods') {
    await withGatewayClient(args, async (client) => {
      const methods = client.hello?.methods || [];
      for (const method of methods) {
        console.log(method);
      }
      if (methods.length === 0) {
        console.log('(no methods advertised)');
      }
    });
    return;
  }

  if (command === 'call') {
    const method = args.shift();
    if (!method?.trim()) {
      throw new Error('gateway call requires <method>.');
    }
    const unsafe = popFlag(args, '--unsafe');
    if (!unsafe && !isMethodAllowed('gateway.call', method)) {
      throw new Error(
        `Method "${method}" is outside gateway.call scope. Use --unsafe to bypass.`,
      );
    }

    const paramsRaw = popOption(args, '--params');
    const params = parseJsonObject(paramsRaw);
    await withGatewayClient(args, async (client) => {
      const result = await client.request(method, params);
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }

  if (command === 'chat') {
    const message = popOption(args, '--message') || args.join(' ').trim();
    if (!message) {
      throw new Error('gateway chat requires --message <text> (or trailing text).');
    }
    const personaId = popOption(args, '--persona');
    const conversationIdFromArg = popOption(args, '--conversation');

    await withGatewayClient(args, async (client) => {
      let conversationId = conversationIdFromArg;
      if (!conversationId) {
        const resetResult = (await client.request('sessions.reset', {
          title: `CLI ${new Date().toISOString()}`,
        })) as { conversationId?: string };
        conversationId = String(resetResult?.conversationId || '');
      }
      if (!conversationId) {
        throw new Error('Could not resolve a conversation id for gateway chat.');
      }

      await client.requestStream(
        'chat.stream',
        {
          conversationId,
          content: message,
          personaId: personaId || undefined,
          clientMessageId: `cli-${Date.now()}`,
        },
        (delta) => {
          if (delta) process.stdout.write(delta);
        },
      );
      process.stdout.write('\n');
    });
    return;
  }

  throw new Error(`Unknown gateway command: ${command}`);
}

