import { spawn } from 'node:child_process';
import {
  approveCommand,
  clearApprovedCommands,
  isCommandApproved,
  listApprovedCommands,
  promptCommandApproval,
  revokeCommand,
} from '../server/gateway/exec-approval-manager';
import { evaluateNodeCommandPolicy } from '../server/gateway/node-command-policy';

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

function printNodeHelp(): void {
  console.log(`openclaw node <command>

Commands:
  run [--command "<cmd>"] [--yes] [--remember] [<cmd...>]
  policy check [--command "<cmd>"] [<cmd...>]
  approve [--command "<cmd>"] [<cmd...>]
  revoke [--command "<cmd>"] [<cmd...>]
  approvals list
  approvals clear

Notes:
  - "node run" executes local shell commands on this machine.
  - approval store path: .local/exec-approvals.json
`);
}

async function runCommand(command: string): Promise<number> {
  const shell =
    process.platform === 'win32'
      ? { file: 'powershell', args: ['-NoProfile', '-Command', command] }
      : { file: '/bin/bash', args: ['-lc', command] };

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(shell.file, shell.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export async function runNodeCli(argv: string[]): Promise<void> {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printNodeHelp();
    return;
  }

  if (command === 'policy') {
    const sub = args.shift();
    if (sub !== 'check') {
      throw new Error('node policy supports only: check');
    }
    const rawCommand = popOption(args, '--command') || args.join(' ').trim();
    const policy = evaluateNodeCommandPolicy(rawCommand);
    console.log(JSON.stringify(policy, null, 2));
    if (!policy.allowed) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'approve') {
    const rawCommand = popOption(args, '--command') || args.join(' ').trim();
    if (!rawCommand) {
      throw new Error('node approve requires a command (option or positional).');
    }
    approveCommand(rawCommand);
    const policy = evaluateNodeCommandPolicy(rawCommand);
    console.log(`Approved command fingerprint: ${policy.fingerprint}`);
    return;
  }

  if (command === 'revoke') {
    const rawCommand = popOption(args, '--command') || args.join(' ').trim();
    if (!rawCommand) {
      throw new Error('node revoke requires a command (option or positional).');
    }
    const removed = revokeCommand(rawCommand);
    console.log(removed ? 'Approval removed.' : 'No matching approval found.');
    return;
  }

  if (command === 'approvals') {
    const sub = args.shift();
    if (sub === 'list') {
      const entries = listApprovedCommands();
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (sub === 'clear') {
      clearApprovedCommands();
      console.log('All command approvals cleared.');
      return;
    }
    throw new Error('node approvals supports: list, clear');
  }

  if (command === 'run') {
    const rawCommand = popOption(args, '--command') || args.join(' ').trim();
    const autoApprove = popFlag(args, '--yes');
    const remember = popFlag(args, '--remember');
    if (!rawCommand) {
      throw new Error('node run requires a command (option or positional).');
    }

    const policy = evaluateNodeCommandPolicy(rawCommand);
    if (!policy.allowed) {
      throw new Error(policy.reason || 'Command blocked by security policy.');
    }

    let approved = isCommandApproved(rawCommand);
    let persistApproval = remember;

    if (!approved && autoApprove) {
      approved = true;
    }

    if (!approved && !autoApprove) {
      const decision = await promptCommandApproval(rawCommand);
      approved = decision.approved;
      persistApproval = decision.remember;
    }

    if (!approved) {
      throw new Error('Command execution denied.');
    }

    if (persistApproval) {
      approveCommand(rawCommand);
    }

    const exitCode = await runCommand(rawCommand);
    process.exitCode = exitCode;
    return;
  }

  throw new Error(`Unknown node command: ${command}`);
}
