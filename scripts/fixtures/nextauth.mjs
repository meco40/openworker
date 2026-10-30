// Use the installed reference implementation; resolution errors must fail the check.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('next-auth'));
export const { AuthHandler } = require(join(root, 'core/index.js'));
export const { createCSRFToken } = require(join(root, 'core/lib/csrf-token.js'));
export const { serialize } = createRequire(join(root, 'core/index.js'))('cookie');
export const version = require(join(root, 'package.json')).version;
