import { GoogleGenAI } from '@google/genai';
import { getRuntimeConfigValue } from '@/server/skills/runtimeConfig';
import { fetchWithSsrfGuard, readResponseBytesLimited } from '@/server/http/ssrfGuard';

function getServerGeminiKey(): string {
  const key = getRuntimeConfigValue('vision.gemini_api_key') || '';
  if (!key) {
    throw new Error(
      'Vision API key missing. Configure "Vision (Gemini) API Key" in Skill Registry > Tool Configuration or set GEMINI_API_KEY.',
    );
  }
  return key;
}

export async function visionAnalyzeHandler(args: Record<string, unknown>) {
  const imageUrl = String(args.imageUrl || '').trim();
  const imageBase64 = String(args.imageBase64 || '').trim();
  const focus =
    String(args.focus || '').trim() ||
    'Describe the image, important objects, and any visible text.';
  const mimeType = String(args.mimeType || 'image/png').trim();

  let data = imageBase64;
  let effectiveMime = mimeType;

  if (!data && imageUrl) {
    const response = await fetchWithSsrfGuard(imageUrl, undefined, { maxRedirects: 0 });
    if (!response.ok) throw new Error(`Unable to download image (${response.status}).`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      throw new Error(`Unable to download image: unexpected content type ${contentType}.`);
    }
    const bytes = await readResponseBytesLimited(response, 10 * 1024 * 1024);
    data = Buffer.from(bytes).toString('base64');
    effectiveMime = contentType || mimeType;
  }

  if (!data) {
    throw new Error('vision_analyze requires imageBase64 or imageUrl.');
  }

  const apiKey = getServerGeminiKey();

  const ai = new GoogleGenAI({ apiKey });
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash-latest',
    contents: [
      {
        role: 'user',
        parts: [{ text: focus }, { inlineData: { mimeType: effectiveMime, data } }],
      },
    ],
  });

  return {
    analysis: result.text || '',
    mimeType: effectiveMime,
  };
}
