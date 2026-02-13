import { GoogleGenAI } from '@google/genai';
import { getRuntimeConfigValue } from '../runtimeConfig';

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
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Unable to download image (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    data = Buffer.from(bytes).toString('base64');
    effectiveMime = response.headers.get('content-type') || mimeType;
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
