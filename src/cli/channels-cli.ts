import { GatewayRpcClient } from '@/cli/lib/gatewayRpc';

function popOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return undefined;
  const [value] = args.splice(index, 2).slice(1);
  return value;
}

function printChannelsHelp(): void {
  console.log(`openclaw channels <command>

Commands:
  list [--url <ws-url>]                         List channel bindings + capabilities
  status [--url <ws-url>]                       Alias for list
  pair --channel <name> [--token <value>]       Pair a channel
  unpair --channel <name>                       Unpair a channel
`);
}

async function withClient<T>(
  args: string[],
  run: (client: GatewayRpcClient) => Promise<T>,
): Promise<T> {
  const url = popOption(args, '--url');
  const client = await GatewayRpcClient.connect({ url });
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

export async function runChannelsCli(argv: string[]): Promise<void> {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printChannelsHelp();
    return;
  }

  if (command === 'list' || command === 'status') {
    await withClient(args, async (client) => {
      const result = await client.request('channels.list', {});
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }

  if (command === 'pair') {
    const channel = popOption(args, '--channel');
    const token = popOption(args, '--token');
    if (!channel?.trim()) {
      throw new Error('channels pair requires --channel <name>.');
    }
    await withClient(args, async (client) => {
      const result = await client.request('channels.pair', {
        channel: channel.trim(),
        token: token || '',
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }

  if (command === 'unpair') {
    const channel = popOption(args, '--channel');
    if (!channel?.trim()) {
      throw new Error('channels unpair requires --channel <name>.');
    }
    await withClient(args, async (client) => {
      const result = await client.request('channels.unpair', {
        channel: channel.trim(),
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }

  throw new Error(`Unknown channels command: ${command}`);
}
