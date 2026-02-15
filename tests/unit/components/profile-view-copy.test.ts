import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';

import ProfileView from '../../../components/ProfileView';

describe('ProfileView copy', () => {
  it('does not mention multi-tenant organization wording', () => {
    const html = renderToString(React.createElement(ProfileView));
    expect(html).not.toContain('multi-tenant organization');
  });
});

