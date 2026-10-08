'use client';

import React from 'react';
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer } from 'recharts';
import type { PersonalityStat } from '@/lib/personalityMatrix';

interface PersonalityRadarProps {
  stats: PersonalityStat[];
}

const PersonalityRadar: React.FC<PersonalityRadarProps> = ({ stats }) => (
  <ResponsiveContainer width="100%" height={256}>
    <RadarChart cx="50%" cy="50%" outerRadius="56%" data={stats}>
      <PolarGrid stroke="#27272a" />
      <PolarAngleAxis
        dataKey="subject"
        tick={{ fill: '#a1a1aa', fontSize: 8, fontWeight: 'bold' }}
      />
      <Radar
        name="Evolution"
        dataKey="A"
        stroke="#8b5cf6"
        fill="#8b5cf6"
        fillOpacity={0.4}
        isAnimationActive={false}
      />
    </RadarChart>
  </ResponsiveContainer>
);

export default PersonalityRadar;
