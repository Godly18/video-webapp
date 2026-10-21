import { AppError } from '../lib/errors.js';
import { validateWords } from '../domain/timeline.js';

export function parseOffset(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return Number(m[1]);
    const n = Number(v); if (Number.isFinite(n) && v.trim() !== '') return n;
  }
  return NaN;
}
/** Reads steps[].content[].annotations[] of type word_info (documented response shape). */
export function extractWords(interaction) {
  const raw = [];
  for (const step of interaction?.steps ?? []) for (const c of step.content ?? []) for (const a of c.annotations ?? [])
    if (a.type === 'word_info') raw.push(a);
  return raw.map((a, index) => ({ word: String(a.text ?? ''), startSeconds: parseOffset(a.start_offset ?? a.startOffset), endSeconds: parseOffset(a.end_offset ?? a.endOffset), index }));
}
export function extractText(interaction) {
  if (typeof interaction?.output_text === 'string') return interaction.output_text;
  if (typeof interaction?.outputText === 'string') return interaction.outputText;
  const parts = [];
  for (const step of interaction?.steps ?? []) for (const c of step.content ?? []) if (c.type === 'text' && c.text) parts.push(c.text);
  return parts.join('');
}
/** Validates the API output; refuses to continue without real word-level timestamps (never fabricates them). */
export function buildTranscript(interaction, durationSeconds) {
  const words = extractWords(interaction).filter((w) => w.word.trim() !== '').map((w, i) => ({ ...w, index: i }));
  if (words.length === 0) throw new AppError(502, 'TRANSCRIPT_NO_WORD_TIMESTAMPS', 'The transcription did not include word-level timestamps.');
  const errors = validateWords(words, durationSeconds);
  if (errors.length) throw new AppError(502, 'TRANSCRIPT_INVALID_TIMESTAMPS', 'The transcription returned invalid word timestamps: ' + errors[0].message, { details: errors.slice(0, 5) });
  return { text: extractText(interaction), words };
}

const MIME = { mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/m4a', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', opus: 'audio/opus', aiff: 'audio/aiff', aif: 'audio/aiff' };
export const mimeForFilename = (name) => MIME[String(name).split('.').pop().toLowerCase()] || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function classify(e) {
  const msg = String(e?.message || e), status = e?.status ?? e?.code;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return new AppError(429, 'GEMINI_QUOTA', 'The Gemini API quota or rate limit was reached. Please try again later.', { retryable: false });
  if ([500, 502, 503, 504].includes(Number(status)) || /UNAVAILABLE|overloaded/i.test(msg)) return Object.assign(new AppError(503, 'GEMINI_UNAVAILABLE', 'The Gemini API is temporarily unavailable.', { retryable: true }), { transient: true });
  if (e instanceof AppError) return e;
  return new AppError(502, 'GEMINI_ERROR', 'The transcription request failed.', { retryable: false });
}

/** Official Google Gen AI SDK + Interactions API with verbatim mode and word timestamps (per ai.google.dev/gemini-api/docs/transcribe). */
export function createGeminiService(cfg, { sdk } = {}) {
  let ai;
  async function client() {
    if (ai) return ai;
    if (!cfg.gemini.apiKey) throw new AppError(500, 'GEMINI_NOT_CONFIGURED', 'GEMINI_API_KEY is not configured.');
    const { GoogleGenAI } = sdk || await import('@google/genai');
    ai = new GoogleGenAI({ apiKey: cfg.gemini.apiKey });
    return ai;
  }
  async function transcribe({ filePath, filename, durationSeconds, signal }) {
    const mimeType = mimeForFilename(filename);
    if (!mimeType) throw new AppError(422, 'AUDIO_FORMAT_UNSUPPORTED_FOR_TRANSCRIPTION', 'This audio format is not supported for transcription.');
    if (durationSeconds > 30 * 60) throw new AppError(422, 'AUDIO_TOO_LONG_FOR_WORD_TIMESTAMPS', 'Word timestamps are limited to 30 minutes of audio.');
    const c = await client();
    if (!c.interactions?.create) throw new AppError(500, 'GEMINI_SDK_OUTDATED', 'The installed @google/genai SDK does not support the Interactions API. Run: npm install @google/genai@latest');
    let file;
    try {
      file = await c.files.upload({ file: filePath, config: { mimeType } });
      for (let i = 0; i < 60 && file.state === 'PROCESSING'; i++) { await sleep(2000); file = await c.files.get({ name: file.name }); }
      const transcription_config = { mode: { type: 'verbatim', timestamp_granularities: ['word'] } };
      if (cfg.gemini.languageCodes.length) transcription_config.language_codes = cfg.gemini.languageCodes;
      let interaction, lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          interaction = await c.interactions.create({ model: cfg.gemini.model, input: [{ type: 'audio', uri: file.uri, mime_type: file.mimeType || mimeType }], generation_config: { transcription_config } });
          break;
        } catch (e) { lastErr = classify(e); if (!lastErr.transient || attempt === 3 || signal?.aborted) throw lastErr; await sleep(2000 * attempt ** 2); }
      }
      if (!interaction) throw lastErr;
      return { ...buildTranscript(interaction, durationSeconds), model: cfg.gemini.model };
    } catch (e) { throw e instanceof AppError ? e : classify(e); }
    finally { if (file?.name) c.files.delete({ name: file.name }).catch(() => {}); }
  }
  return { transcribe };
}
