export async function executeSkillApi(name: string, args: Record<string, unknown> = {}) {
  const response = await fetch('/api/skills/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });

  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    const message =
      (typeof payload?.error === 'string' && payload.error) ||
      `Skill ${name} failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload.result;
}
