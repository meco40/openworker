import { useCallback, useMemo } from 'react';
import type React from 'react';
import type { Skill } from '../../../../types';

export function useWorkerController(
  skills: Skill[],
  setTerminalLogs: React.Dispatch<React.SetStateAction<string[]>>,
) {
  const activeSkills = useMemo(() => skills.filter((skill) => skill.installed), [skills]);

  const addTerminalLog = useCallback(
    (cmd: string, output: string) => {
      setTerminalLogs((prev) => [...prev, `$ ${cmd}`, `> ${output}`]);
    },
    [setTerminalLogs],
  );

  return {
    activeSkills,
    addTerminalLog,
  };
}
