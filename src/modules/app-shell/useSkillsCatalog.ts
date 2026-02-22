import { useEffect, useState } from 'react';
import type React from 'react';
import type { Skill } from '@/shared/domain/types';

interface UseSkillsCatalogArgs {
  shouldLoadSkills: boolean;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function toSkill(raw: Record<string, unknown>): Skill {
  const sourceValue = raw.source;

  return {
    id: readString(raw.id),
    name: readString(raw.name),
    description: readString(raw.description),
    category: readString(raw.category),
    installed: readBoolean(raw.installed),
    version: readString(raw.version),
    functionName: readString(raw.functionName),
    source:
      sourceValue === 'built-in' ||
      sourceValue === 'github' ||
      sourceValue === 'npm' ||
      sourceValue === 'manual'
        ? sourceValue
        : 'manual',
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : undefined,
  };
}

export function useSkillsCatalog({ shouldLoadSkills }: UseSkillsCatalogArgs): {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
} {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);

  useEffect(() => {
    if (!shouldLoadSkills || skillsLoaded) {
      return;
    }

    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.skills)) {
          setSkills(data.skills.map((entry: Record<string, unknown>) => toSkill(entry)));
          setSkillsLoaded(true);
        }
      })
      .catch((error) => console.error('Failed to load skills:', error));
  }, [shouldLoadSkills, skillsLoaded]);

  return {
    skills,
    setSkills,
  };
}
