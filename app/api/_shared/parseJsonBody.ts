import { NextResponse } from 'next/server';
import type { ZodSchema } from 'zod';

type ParseJsonBodyResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      response: Response;
    };

export async function parseJsonBody<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<ParseJsonBodyResult<T>> {
  const rawBody = await request.json().catch(() => null);
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Validation failed',
          details: parsed.error.issues,
        },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true,
    data: parsed.data,
  };
}
