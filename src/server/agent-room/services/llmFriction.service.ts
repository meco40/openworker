/**
 * LLM-based friction analysis — optional meta-agent enhancement for conflictRadar.
 *
 * Falls back silently to the regex-based `deriveConflictRadar` when:
 *  - GEMINI_API_KEY is not configured
 *  - The LLM call fails for any reason
 *
 * The LLM receives the latest phase text and returns a structured friction assessment
 * with semantic understanding of disagreements, contradictions, and risks.
 */

import { GoogleGenAI } from '@google/genai';
import type { SwarmFriction } from '@/server/agent-room/types';
import { deriveConflictRadar } from './conflictRadar.service';

const LLM_FRICTION_MODEL = 'gemini-2.0-flash';

const FRICTION_SYSTEM_PROMPT = `You are a meta-analyst evaluating a multi-agent discussion for friction signals.

Analyse the text and return a JSON object (no markdown fencing, just raw JSON) with exactly:
{
  "level": "low" | "medium" | "high",
  "confidence": <number 0-100>,
  "hold": <boolean — true if agents are deadlocked>,
  "reasons": [<string — max 4 short sentences describing specific friction points>]
}

Friction signals (ordered by severity):
- DEADLOCK: Agents repeat the same positions without progress
- CONTRADICTION: Agent A says X, Agent B says the opposite
- RISK: Unaddressed risks or blockers raised but ignored
- DISAGREEMENT: Agents have different approaches but are constructively debating (low friction)

Rules:
- If agents disagree constructively, friction is LOW
- If agents contradict each other but make progress, friction is MEDIUM
- If agents are stuck or ignoring critical issues, friction is HIGH
- Set "hold" to true ONLY for genuine deadlocks
- Be concise in reasons — one sentence each`;

/**
 * Attempt LLM-based friction analysis. Falls back to regex-based on failure or missing key.
 */
export async function deriveLlmFriction(artifact: string): Promise<SwarmFriction> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return deriveConflictRadar(artifact);
  }

  // Extract latest phase section
  const markerRegex = /^---\s+.+?\s+---$/gm;
  let lastMarkerEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRegex.exec(artifact))) {
    lastMarkerEnd = m.index + m[0].length;
  }
  const phaseText = artifact.slice(lastMarkerEnd).trim();
  if (!phaseText || phaseText.length < 50) {
    return deriveConflictRadar(artifact);
  }

  try {
    const client = new GoogleGenAI({ apiKey });
    const result = await client.models.generateContent({
      model: LLM_FRICTION_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${FRICTION_SYSTEM_PROMPT}\n\n---\nDISCUSSION TEXT:\n${phaseText.slice(0, 4000)}`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 300,
      },
    });

    const raw = result.text?.trim();
    if (!raw) {
      return deriveConflictRadar(artifact);
    }

    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned) as {
      level?: string;
      confidence?: number;
      hold?: boolean;
      reasons?: string[];
    };

    // Validate shape
    const validLevels = ['low', 'medium', 'high'];
    const level = validLevels.includes(parsed.level ?? '')
      ? (parsed.level as SwarmFriction['level'])
      : 'low';
    const confidence =
      typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : 0;
    const hold = typeof parsed.hold === 'boolean' ? parsed.hold : false;
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 4)
      : [];

    return {
      level,
      confidence,
      hold,
      reasons,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    // Any failure → fall back to regex-based
    return deriveConflictRadar(artifact);
  }
}
