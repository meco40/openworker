import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runChannelsCli } from '@/cli/channels-cli';
import { runGatewayCli } from '@/cli/gateway-cli';
import { runNodeCli } from '@/cli/node-cli';

function printHelp(): void {
  console.log(`openclaw <command>

Commands:
  gateway      Gateway runtime and RPC commands
  channels     Channel pairing and status commands
  node         Local command runtime with approvals

Examples:
  openclaw gateway run
  openclaw gateway chat --message "Hallo"
  openclaw channels list
  openclaw node run --command "Get-ChildItem"
`);
}

export async function runProgram(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'gateway') {
    await runGatewayCli(args);
    return;
  }

  if (command === 'channels') {
    await runChannelsCli(args);
    return;
  }

  if (command === 'node') {
    await runNodeCli(args);
    return;
  }

  // Compatibility shortcut: unknown top-level text is treated as chat message.
  await runGatewayCli(['chat', '--message', [command, ...args].join(' ')]);
}

async function main(): Promise<void> {
  try {
    await runProgram();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === currentFilePath) {
  void main();
}
