import { pathToFileURL } from 'node:url';
import {
  runAttachmentConsistencyAudit,
  type AttachmentConsistencyOptions,
} from '@/server/channels/messages/attachmentConsistency';

interface CliOptions extends AttachmentConsistencyOptions {
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repairPruneMissing: false,
    repairNormalizePersonaBuckets: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === '--repair') {
      options.repairPruneMissing = true;
      options.repairNormalizePersonaBuckets = true;
      continue;
    }
    if (arg === '--repair-prune-missing') {
      options.repairPruneMissing = true;
      continue;
    }
    if (arg === '--repair-normalize-buckets') {
      options.repairNormalizePersonaBuckets = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

function runCli(): void {
  const options = parseArgs(process.argv.slice(2));
  const report = runAttachmentConsistencyAudit(options);

  if (options.json) {
    console.log(JSON.stringify({ options, report }, null, 2));
    return;
  }

  console.log('[attachments-consistency]');
  console.log(`  scannedMessages: ${report.scannedMessages}`);
  console.log(`  scannedAttachments: ${report.scannedAttachments}`);
  console.log(`  missingFiles: ${report.missingFiles}`);
  console.log(`  bucketMismatches: ${report.bucketMismatches}`);
  console.log(`  repairedMissingPruned: ${report.repairedMissingPruned}`);
  console.log(`  repairedBucketMoves: ${report.repairedBucketMoves}`);
  console.log(`  updatedMessages: ${report.updatedMessages}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runCli();
}
