import type { Skill } from '../types';
import type { SkillRuntimeConfigStatus } from './runtime-config-client';
import { buildSkillConfigHints } from './runtime-config-hints';

export interface ToolGuide {
  title: string;
  whatItIs: string;
  whatItCanDo: string[];
  howToUse: string[];
}

type BaseGuide = Omit<ToolGuide, 'title'>;

const BUILT_IN_GUIDES: Record<string, BaseGuide> = {
  browser: {
    whatItIs:
      'Managed Browser fetches a public web page and extracts readable metadata and text snippets.',
    whatItCanDo: [
      'Inspect page title and description quickly.',
      'Return a short text excerpt for analysis or summarization.',
      'Check HTTP status and fetch timestamp.',
    ],
    howToUse: [
      'Activate the tool in Skill Registry.',
      'Ask the assistant to inspect a URL and summarize findings.',
      'Use it for lightweight page checks, not full interactive browser automation.',
    ],
  },
  search: {
    whatItIs:
      'Google Search provides grounded web search context directly to the model.',
    whatItCanDo: [
      'Retrieve fresh web results for current topics.',
      'Support answers with up-to-date context.',
      'Improve factual coverage for web-facing questions.',
    ],
    howToUse: [
      'Keep the tool active for tasks requiring current web knowledge.',
      'Ask natural-language questions; grounding runs automatically.',
      'Combine with Managed Browser when you need details from a specific result URL.',
    ],
  },
  'python-runtime': {
    whatItIs:
      'Python Executor runs short Python code snippets and returns stdout/stderr.',
    whatItCanDo: [
      'Perform calculations and transformations.',
      'Run quick data inspection scripts.',
      'Prototype logic before production implementation.',
    ],
    howToUse: [
      'Activate the tool.',
      'Ask the assistant to execute a specific Python snippet.',
      'Keep jobs short and focused for fast feedback.',
    ],
  },
  'shell-access': {
    whatItIs:
      'Safe Shell executes PowerShell commands with timeout and policy-based blocking.',
    whatItCanDo: [
      'Run local checks like tests, linting, and build commands.',
      'Inspect files, git state, and environment outputs.',
      'Automate repetitive command-line steps.',
    ],
    howToUse: [
      'Activate the tool.',
      'Ask the assistant with exact command intent (for example: run unit tests).',
      'Use short-running commands; long or destructive commands may fail or be blocked.',
    ],
  },
  'github-manager': {
    whatItIs:
      'GitHub Connector calls GitHub APIs for repo metadata, issues, PRs, and code search.',
    whatItCanDo: [
      'Read repository info and open issues/PRs.',
      'Search code inside a repository.',
      'Support repository diagnostics from chat.',
    ],
    howToUse: [
      'Activate the tool.',
      'Optionally add a GitHub token for higher limits and private repos.',
      'Ask with repository context (owner/repo) and desired action.',
    ],
  },
  vision: {
    whatItIs:
      'Live Vision analyzes images with Gemini and returns structured visual insights.',
    whatItCanDo: [
      'Describe scenes, objects, and visible text.',
      'Focus analysis on a user-defined target area.',
      'Accept image URL or base64 image payload.',
    ],
    howToUse: [
      'Configure the required Vision (Gemini) API Key.',
      'Activate the tool.',
      'Ask the assistant to analyze an image and specify the focus if needed.',
    ],
  },
  'sql-bridge': {
    whatItIs:
      'SQL Bridge executes read-only SQL queries against a configured SQLite database.',
    whatItCanDo: [
      'Run SELECT/WITH/PRAGMA/EXPLAIN statements.',
      'Return query rows with safe truncation.',
      'Support quick data diagnostics from chat.',
    ],
    howToUse: [
      'Configure the SQLite Database Path.',
      'Activate the tool.',
      'Ask with a read-only SQL query and expected output.',
    ],
  },
  filesystem: {
    whatItIs:
      'File Gateway reads files inside the workspace with path-safety checks.',
    whatItCanDo: [
      'Load local text files for analysis.',
      'Return truncated content for very large files.',
      'Prevent path escape outside the workspace root.',
    ],
    howToUse: [
      'Activate the tool.',
      'Ask the assistant to read a specific relative file path.',
      'Use it with other tools for investigation workflows.',
    ],
  },
};

function appendSetupHints(
  baseHowToUse: string[],
  skillId: string,
  runtimeConfigs: SkillRuntimeConfigStatus[],
): string[] {
  const hints = buildSkillConfigHints(skillId, runtimeConfigs);
  const out = [...baseHowToUse];
  if (hints.requiredHint) {
    out.push(hints.requiredHint);
  }
  if (hints.optionalHint) {
    out.push(hints.optionalHint);
  }
  return out;
}

export function getToolGuide(
  skill: Skill,
  runtimeConfigs: SkillRuntimeConfigStatus[],
): ToolGuide {
  const builtIn = BUILT_IN_GUIDES[skill.id];
  if (builtIn) {
    return {
      title: skill.name,
      whatItIs: builtIn.whatItIs,
      whatItCanDo: builtIn.whatItCanDo,
      howToUse: appendSetupHints(builtIn.howToUse, skill.id, runtimeConfigs),
    };
  }

  const genericHowTo = [
    'Activate the tool in Skill Registry.',
    `Use the tool function name \`${skill.functionName}\` through assistant requests.`,
    'Start with a small request to validate behavior.',
  ];

  if (skill.sourceUrl) {
    genericHowTo.push(`Review source details: ${skill.sourceUrl}`);
  }

  return {
    title: skill.name,
    whatItIs: skill.description,
    whatItCanDo: [
      `Provides capabilities under category "${skill.category}".`,
      'Can be called by the assistant when the task matches this tool.',
      `Uses function entrypoint \`${skill.functionName}\`.`,
    ],
    howToUse: appendSetupHints(genericHowTo, skill.id, runtimeConfigs),
  };
}
