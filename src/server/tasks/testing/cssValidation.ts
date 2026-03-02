import * as csstree from 'css-tree';
import type { CssValidationError } from './types';

export function validateCss(css: string): CssValidationError[] {
  const errors: CssValidationError[] = [];

  try {
    csstree.parse(css, {
      parseAtrulePrelude: false,
      parseRulePrelude: false,
      parseValue: false,
      onParseError: (error) => {
        errors.push({
          message: error.rawMessage || error.message,
        });
      },
    });
  } catch (error) {
    errors.push({
      message: `CSS parse error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return errors;
}

export function extractAndValidateCss(htmlContent: string): CssValidationError[] {
  const errors: CssValidationError[] = [];
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match;

  while ((match = styleRegex.exec(htmlContent)) !== null) {
    const cssContent = match[1];
    const cssErrors = validateCss(cssContent);
    errors.push(...cssErrors);
  }

  return errors;
}
