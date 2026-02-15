import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';

import ProfileView from '../../../components/ProfileView';

describe('ProfileView copy', () => {
  it('uses single-user wording and removes saas billing language', () => {
    const html = renderToString(React.createElement(ProfileView));
    expect(html).toContain('Operator Identity &amp; Runtime');
    expect(html).toContain('Local Usage &amp; Capacity');
    expect(html).not.toContain('SaaS Identity &amp; Billing');
    expect(html).not.toContain('subscription plan');
    expect(html).not.toContain('Subscription &amp; Usage');
    expect(html).not.toContain('Active Plan');
    expect(html).not.toContain('PRO_NODE');
    expect(html).not.toContain('Upgrade to Enterprise Node');
  });
});
