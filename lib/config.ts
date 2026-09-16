// Single place every environment knob is read. Importing process.env directly
// anywhere else makes the deployable surface impossible to audit.

export const APP_NAME = "Mise";

function str(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}
function int(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  dataDir: str("DATA_DIR", "./data"),
  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    /** Fallback chain — a busy model answers 503, so one name is not enough. */
    models: str("GEMINI_MODELS", "gemini-2.5-flash,gemini-3.5-flash,gemini-2.5-flash-lite")
      .split(",").map((s) => s.trim()).filter(Boolean),
  },
  telegram: {
    botToken: str("TELEGRAM_BOT_TOKEN"),
    chatId: str("TELEGRAM_CHAT_ID"),
    /** Overridable so the bot's polling loop can be pointed at a local stub in
     *  tests — there is no other way to exercise it without a live token. */
    apiBase: str("TELEGRAM_API_BASE", "https://api.telegram.org"),
  },
  ingestToken: str("OSTA_INGEST_TOKEN"),
  apiBase: str("MISE_API_BASE", "http://localhost:3000"),
  publicBase: str("MISE_PUBLIC_BASE", "http://localhost:3000"),
  extraction: {
    enableAudioTier: bool("ENABLE_AUDIO_TIER", true),
    maxAudioSeconds: int("MAX_AUDIO_SECONDS", 300),
    cookiesFile: str("YTDLP_COOKIES_FILE"),
  },
  worker: {
    enabled: bool("WORKER_ENABLED", true),
    pollMs: int("WORKER_POLL_MS", 2000),
    maxAttempts: int("WORKER_MAX_ATTEMPTS", 3),
  },
} as const;

export function geminiConfigured(): boolean {
  return config.gemini.apiKey.length > 0;
}
