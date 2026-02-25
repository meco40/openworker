'use client';

import { useEffect, useState } from 'react';

export default function DemoBanner() {
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    fetch('/api/demo')
      .then((r) => r.json())
      .then((data) => setIsDemo(data.demo))
      .catch(() => {});
  }, []);

  if (!isDemo) return null;

  return (
    <div className="relative z-50 bg-gradient-to-r from-blue-600 via-purple-600 to-blue-600 px-4 py-2 text-center text-sm font-medium text-white">
      <span className="mr-2">🎮</span>
      <span>Live Demo — AI agents are working in real-time. This is a read-only simulation.</span>
      <a
        href="https://github.com/crshdn/mission-control"
        target="_blank"
        rel="noopener noreferrer"
        className="ml-3 underline transition-colors hover:text-blue-200"
      >
        Get Mission Control →
      </a>
    </div>
  );
}
