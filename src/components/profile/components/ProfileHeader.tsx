'use client';

import React from 'react';

export const ProfileHeader: React.FC = () => {
  return (
    <header>
      <h2 className="text-3xl font-black tracking-tight text-white uppercase">
        Operator Identity & Runtime
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        Manage your local operator profile and runtime settings.
      </p>
    </header>
  );
};
