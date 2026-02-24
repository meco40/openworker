import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'http-request',
  name: 'HTTP Request',
  description: 'Führt generische REST-API-Anfragen durch (GET, POST, PUT, PATCH, DELETE).',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'http_request',
  tool: {
    name: 'http_request',
    description:
      'Make an HTTP request to an external API. Supports GET, POST, PUT, PATCH, DELETE, HEAD. Can send JSON bodies and custom headers. Use for REST API calls, webhooks, or any HTTP interaction. Requires OPENCLAW_HTTP_SKILL_ENABLED=true.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to call (must be a public HTTP/HTTPS endpoint).',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP method (default: GET).',
        },
        headers: {
          type: 'object',
          description: 'Optional request headers as key-value pairs.',
        },
        body: {
          type: 'object',
          description: 'Optional request body (object for JSON, string for raw).',
        },
      },
      required: ['url'],
    },
  },
};

const httpRequestSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('http_request', args),
};

export default httpRequestSkill;
