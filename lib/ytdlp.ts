// The only place this app spawns a process. Everything hostile about the
// pipeline is concentrated here, so the rules are concentrated here too:
//
//   • `execFile` with an ARGUMENT ARRAY — never `exec`, never a template
//     string. `exec` hands the string to /bin/sh, which means a URL containing
//     `;` or backticks becomes code. An argv array is data all the way down.
//   • `--` before the URL, so a URL beginning with `-` cannot be read by
//     yt-dlp as a flag (argv arrays stop shell injection, not *option*
//     injection — different bug, same file).
//   • `--ignore-config`, so a stray ~/.config/yt-dlp/config on the host cannot
//     silently add options we did not choose.
//   • A timeout with a hard kill. A subprocess that hangs would wedge the
//     single-threaded worker loop forever.
//   • Missing binary is a DEGRADED path, not a crash: this Mac has no yt-dlp,
//     the container does. The fallbacks (oEmbed, embed scrape) must still run
//     locally.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { classify } from "./extract/classify";

/** The subset of yt-dlp's `--dump-json` we actually read. */
export type YtdlpInfo = {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  thumbnail?: string;
  duration?: number;
  webpage_url?: string;
  automatic_captions?: Record<string, { ext?: string; url?: string }[]>;
  subtitles?: Record<string, { ext?: string; url?: string }[]>;
};

const JSON_TIMEOUT_MS = 45_000;
const AUDIO_TIMEOUT_MS = 180_000;

let availability: Promise<boolean> | null = null;

/** Cached because it spawns a process, and the worker asks on every import. */
export function ytdlpAvailable(): Promise<boolean> {
  if (!availability) {
    availability = run(["--version"], 10_000)
      .then((r) => r.ok)
      .catch(() => false);
  }
  return availability;
}

type RunResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "missing" | "failed" | "timeout"; message: string };

async function run(args: string[], timeoutMs: number): Promise<RunResult> {
  const baseArgs = ["--ignore-config", "--no-playlist", "--no-warnings", ...args];
  return new Promise((resolve) => {
    execFile(
      "yt-dlp",
      baseArgs,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") {
          return resolve({ ok: false, reason: "missing", message: "yt-dlp is not installed." });
        }
        if (e.killed) {
          return resolve({ ok: false, reason: "timeout", message: "yt-dlp timed out." });
        }
        resolve({ ok: false, reason: "failed", message: firstUsefulLine(stderr) || e.message });
      },
    );
  });
}

/** yt-dlp is chatty on failure; the user only ever sees one line of it. */
function firstUsefulLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("ERROR:") || l.length > 0);
  return (line ?? "").replace(/^ERROR:\s*/, "").slice(0, 300);
}

function cookieArgs(): string[] {
  // Public posts need no cookies (docs/RESEARCH-extraction.md §2). This exists
  // for the private/age-gated case only, and is empty by default.
  return config.extraction.cookiesFile ? ["--cookies", config.extraction.cookiesFile] : [];
}

/**
 * `yt-dlp --dump-json <url>` → parsed metadata, or null if yt-dlp is absent or
 * the platform refused. Callers treat null as "this route did not work",
 * never as "this post does not exist" — see the 200-with-empty-shell trap in
 * docs/RESEARCH-extraction.md §2.
 */
export async function ytdlpJson(url: string): Promise<YtdlpInfo | null> {
  // Defence in depth: even though every caller comes from classify(), a second
  // check here means no future caller can spawn a process on an unvetted URL.
  if (!classify(url).ok) return null;

  const r = await run(
    [...cookieArgs(), "--skip-download", "--dump-single-json", "--socket-timeout", "20", "--", url],
    JSON_TIMEOUT_MS,
  );
  if (!r.ok) {
    if (r.reason !== "missing") console.warn(`[ytdlp] json failed: ${r.message}`);
    return null;
  }
  try {
    return JSON.parse(r.stdout) as YtdlpInfo;
  } catch {
    return null;
  }
}

/**
 * Download audio only, into `dir`. Returns the file path and a mime type Gemini
 * understands, or null.
 *
 * Two attempts on purpose: `-x --audio-format mp3` needs ffmpeg, which the
 * container has and a bare machine may not, so the fallback grabs the smallest
 * native audio stream and skips transcoding entirely.
 */
export async function ytdlpAudio(
  url: string,
  dir: string,
  maxSeconds: number,
  /** Null when the platform never told us (Instagram always does this). */
  knownDurationSeconds: number | null = null,
): Promise<{ filePath: string; mimeType: string } | null> {
  if (!classify(url).ok) return null;

  // ⚠️ `--match-filter duration < N` REJECTS a video whose duration is unknown,
  // not just one that is too long — and appending yt-dlp's `?` "optional field"
  // suffix does not change that (measured against a real reel on 2026-09-16:
  // both `duration < 301` and `duration<301?` logged "does not pass filter").
  // Instagram's extractor reports `duration: NA`, so keeping the filter
  // unconditionally meant the audio tier could NEVER run on a Reel — the exact
  // case it exists for.
  //
  // So the filter is only applied when we actually know the duration. When we
  // do not, the bound is `--max-filesize` plus the SIGKILL timeout on the
  // subprocess: a long video blows the byte cap and is aborted mid-download,
  // which protects the SSD just as well, only less precisely.
  const durationFilter =
    knownDurationSeconds !== null
      ? ["--match-filter", `duration < ${Math.max(1, Math.floor(maxSeconds) + 1)}`]
      : [];

  const common = [
    ...cookieArgs(),
    "--socket-timeout", "20",
    // The real ceiling. Holds whether or not the duration was known.
    "--max-filesize", "48M",
    ...durationFilter,
    "--no-part",
  ];

  const attempts: string[][] = [
    [...common, "-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", path.join(dir, "audio.%(ext)s"), "--", url],
    [...common, "-f", "bestaudio[ext=m4a]/bestaudio", "-o", path.join(dir, "audio.%(ext)s"), "--", url],
  ];

  for (const args of attempts) {
    const r = await run(args, AUDIO_TIMEOUT_MS);
    if (!r.ok) {
      if (r.reason === "missing") return null;
      console.warn(`[ytdlp] audio attempt failed: ${r.message}`);
      continue;
    }
    const found = await findAudioFile(dir);
    if (found) return found;
  }
  return null;
}

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mp3",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

async function findAudioFile(dir: string): Promise<{ filePath: string; mimeType: string } | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const mime = AUDIO_MIME[path.extname(name).toLowerCase()];
    if (mime) return { filePath: path.join(dir, name), mimeType: mime };
  }
  return null;
}

// ── Temp file hygiene ────────────────────────────────────────────────────────
// The SSD is 232 GB shared with every other homelab service. Downloads live in
// ONE directory under DATA_DIR so that a single sweep can guarantee cleanup,
// rather than being scattered through the OS temp dir where nothing owns them.

export function tempRoot(): string {
  return path.join(config.dataDir, "tmp");
}

export async function makeTempDir(prefix = "import"): Promise<string> {
  const root = tempRoot();
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${prefix}-`));
}

/** Delete a temp dir, never throwing — this is always called from a `finally`,
 *  where a second exception would mask the real one. */
export async function removeTempDir(dir: string): Promise<void> {
  if (!dir || !dir.startsWith(tempRoot())) return; // refuse to rm outside our own tree
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[ytdlp] could not remove ${dir}:`, e);
  }
}

/**
 * Startup sweep: anything left in the temp root from a crashed or SIGKILLed
 * import is orphaned by definition, because imports run one at a time.
 * `maxAgeMs` exists only so a future concurrent worker cannot delete a live
 * download out from under itself.
 */
export async function sweepTempDir(maxAgeMs = 0): Promise<number> {
  const root = tempRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0; // nothing to sweep; the dir is created lazily
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    const full = path.join(root, name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs > cutoff) continue;
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // A file that vanished mid-sweep is exactly the outcome we wanted.
    }
  }
  if (removed > 0) console.log(`[ytdlp] swept ${removed} orphaned temp item(s) from ${root}`);
  return removed;
}
