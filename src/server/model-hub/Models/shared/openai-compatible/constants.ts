export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.7;
export const MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH = 12000;

export const CONTENT_TYPE_JSON = 'application/json';
export const CONTENT_TYPE_EVENT_STREAM = 'text/event-stream';

export const SSE_DATA_PREFIX = 'data:';
export const SSE_DONE_MARKER = '[DONE]';
export const SSE_BLOCK_SEPARATOR = '\n\n';

export const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi;

export const PROVIDERS_SUPPORTING_REASONING_EFFORT = ['openai', 'openai-codex'];
