import { pathToFileURL } from 'node:url';
import { queryAll } from '@/lib/db';
import { cleanupOrphanTaskWorkspaces } from '@/server/tasks/taskWorkspace';

interface CliOptions {
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    json: argv.includes('--json'),
  };
}

function runCli(): void {
  const options = parseArgs(process.argv.slice(2));
  const rows = queryAll<{ id: string }>('SELECT id FROM tasks');
  const activeTaskIds = rows.map((row) => row.id);
  const report = cleanupOrphanTaskWorkspaces(activeTaskIds);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          activeTaskCount: activeTaskIds.length,
          ...report,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('[cleanup-task-workspaces]');
  console.log(`  activeTaskCount: ${activeTaskIds.length}`);
  console.log(`  scanned: ${report.scanned}`);
  console.log(`  removed: ${report.removed}`);
  console.log(`  kept: ${report.kept}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runCli();
}
