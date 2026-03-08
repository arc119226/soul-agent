/**
 * Edge TTS — free text-to-speech via Microsoft Edge's online service.
 *
 * Returns an MP3 Buffer that Telegram accepts via sendVoice (displayed as
 * a playable voice message bubble).  No API key, no ffmpeg needed.
 */

import { logger } from '../core/logger.js';

// Default voice: Taiwan Mandarin female
const DEFAULT_VOICE = 'zh-TW-HsiaoChenNeural';

// Language → voice mapping for auto-selection
const VOICE_MAP: Record<string, string> = {
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'en':    'en-US-AnaNeural',
  'ja':    'ja-JP-NanamiNeural',
  'ko':    'ko-KR-SunHiNeural',
};

export interface TTSOptions {
  /** BCP-47 language tag or key in VOICE_MAP. Default: zh-TW */
  lang?: string;
  /** Override voice name directly (takes priority over lang) */
  voice?: string;
  /** Speaking rate, e.g. "+10%" or "-20%". Default: "+0%" */
  rate?: string;
}

/**
 * Synthesize text to an MP3 Buffer using Edge TTS.
 * Returns null on failure (non-throwing).
 */
export async function synthesize(
  text: string,
  opts?: TTSOptions,
): Promise<Buffer | null> {
  try {
    const { EdgeTTS } = await import('@andresaya/edge-tts');
    const tts = new EdgeTTS();

    const voice = opts?.voice
      ?? VOICE_MAP[opts?.lang ?? '']
      ?? DEFAULT_VOICE;

    const options: Record<string, string> = {};
    if (opts?.rate) options.rate = opts.rate;

    await tts.synthesize(text, voice, options);
    const buffer = tts.toBuffer();

    if (!buffer || buffer.length === 0) {
      await logger.warn('tts', 'Edge TTS returned empty buffer');
      return null;
    }

    await logger.debug('tts', `Synthesized ${text.length} chars → ${buffer.length} bytes (${voice})`);
    return buffer;
  } catch (err) {
    await logger.error('tts', 'Edge TTS synthesis failed', err);
    return null;
  }
}

/** Get the list of available voices (for future /voices command) */
export async function listVoices(lang?: string): Promise<Array<{ name: string; locale: string; gender: string }>> {
  try {
    const { EdgeTTS } = await import('@andresaya/edge-tts');
    const tts = new EdgeTTS();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const voices = await tts.getVoices() as any[];

    const filtered = lang
      ? voices.filter((v) => v.Locale?.startsWith(lang))
      : voices;

    return filtered.map((v) => ({
      name: v.ShortName ?? v.Name ?? '',
      locale: v.Locale ?? '',
      gender: v.Gender ?? '',
    }));
  } catch {
    return [];
  }
}
