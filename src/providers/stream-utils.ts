/**
 * NDJSON parsing utilities for adapters that consume line-delimited JSON
 * from a CLI's stdout (Claude `--output-format stream-json`, Codex `--json`).
 */

const MAX_STREAM_CHARS = 64_000;

// CLI output can contain terminal control sequences even in JSON mode when a
// nested command or native dependency writes diagnostics. Keep those bytes out
// of browser text nodes; broken UTF-8 ANSI prefixes are handled as well.
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /(?:\x1b\[|\uFFFD\[)[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uFFFD]/g;

export function sanitizeCliText(text: string): string {
  if (!text) return '';
  const stripped = text.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
  let unsafe = 0;
  for (const char of stripped) {
    const code = char.charCodeAt(0);
    if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || (code >= 0x7f && code <= 0x9f)) unsafe++;
  }
  if (unsafe > Math.max(4, stripped.length * 0.12)) return '';
  const cleaned = stripped.replace(UNSAFE_CONTROL, '');
  if (/AWAVAUATVWUSH/.test(cleaned) && /[^\x20-\x7e\r\n\t]/.test(cleaned)) return '';
  return cleaned;
}

/** Keep visible reasoning useful without turning command/code dumps into a wall. */
export function compactThinkingText(text: string, maxChars = 700): string {
  const clean = sanitizeCliText(text).trim();
  if (!clean) return '';
  const lines = clean.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const codeLikeLines = lines.filter(line =>
    /^\s*\d+:\s/.test(line)
    || /^\s*(?:at |FAIL\b|PASS\b|Expected\b|Received\b|[+\-] )/i.test(line)
    || /[{}();]{3,}/.test(line),
  ).length;
  if (lines.length >= 6 && codeLikeLines >= Math.ceil(lines.length * 0.45)) {
    const narrative = lines.find(line =>
      !/^\s*\d+:\s/.test(line)
      && !/^\s*(?:at |FAIL\b|PASS\b|Expected\b|Received\b|[+\-] )/i.test(line)
      && !/[{}();]{3,}/.test(line),
    );
    return narrative && narrative.length <= 180
      ? narrative
      : 'Reviewing code and command results…';
  }
  const normalized = lines.join('\n');
  if (normalized.length <= maxChars) return normalized;
  const sentenceEnd = normalized.lastIndexOf('. ', maxChars);
  const cut = sentenceEnd >= Math.floor(maxChars * 0.45) ? sentenceEnd + 1 : maxChars;
  return normalized.slice(0, cut).trimEnd() + '…';
}

/** Drain a stream to a string, capped to avoid runaway memory. */
export async function drainStreamToString(
  stream: ReadableStream<Uint8Array>,
  maxChars = MAX_STREAM_CHARS,
  signal?: AbortSignal,
  retain: 'head' | 'tail' = 'tail',
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      if (retain === 'head') {
        if (text.length < maxChars) text += decoded.slice(0, maxChars - text.length);
      } else {
        text += decoded;
        if (text.length > maxChars) text = text.slice(-maxChars);
      }
    }
    const final = decoder.decode();
    if (retain === 'head') {
      if (text.length < maxChars) text += final.slice(0, maxChars - text.length);
      return text;
    }
    text += final;
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Parse complete NDJSON lines out of a rolling buffer; return the trailing
 * partial line as the new buffer. Lines that fail to parse are dropped
 * silently — the caller (adapter) sees only the events that JSON.parse'd.
 */
export function parseNdjsonLines(
  leftover: string,
  handler: (event: any) => void,
): string {
  const lines = leftover.split('\n');
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    try {
      handler(JSON.parse(trimmed));
    } catch {
      // Malformed line — ignore. Real adapters log via emitSystemMessage if needed.
    }
  }
  return remainder;
}

/** Flush a final partial line at stream end. */
export function flushNdjsonLeftover(
  leftover: string,
  handler: (event: any) => void,
): void {
  const trimmed = leftover.replace(/\r$/, '').trim();
  if (!trimmed) return;
  try {
    handler(JSON.parse(trimmed));
  } catch {
    // Drop.
  }
}

// --- helpers ----------------------------------------------------------------

function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function basename(p: string): string {
  if (!p) return p;
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/**
 * Best-effort one-line summary of a tool input. Returns an empty string when
 * no useful field is present — the caller decides how to render that case
 * (typically as just `[ToolName]` with no colon-suffix).
 *
 * Covers the common Claude / Codex tool input shapes:
 *   - Bash / shell:                 { command }       → the command string
 *   - WebSearch / search:           { query }         → the query string
 *   - Read / Edit / NotebookEdit:   { file_path }     → basename of the path
 *   - Glob / Grep:                  { pattern }       → the pattern string
 *   - WebFetch:                     { url }           → the URL
 *   - LS:                           { path }          → basename of the path
 *   - MultiEdit / batch operations: { files | changes } → first basename + count
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const payload = input as Record<string, unknown>;

  const command = payload.command ?? payload.cmd;
  if (typeof command === 'string' && command) return trimText(command, 64);

  const query = payload.query;
  if (typeof query === 'string' && query) return trimText(query, 64);

  // Glob / Grep — pattern is the load-bearing field
  const pattern = payload.pattern;
  if (typeof pattern === 'string' && pattern) return trimText(pattern, 64);

  // WebFetch — URL identifies the call
  const url = payload.url;
  if (typeof url === 'string' && url) return trimText(url, 64);

  const path = payload.path ?? payload.file ?? payload.file_path;
  if (typeof path === 'string' && path) return basename(path);

  const files = payload.files ?? payload.changes;
  if (Array.isArray(files) && files.length > 0) {
    const first = files[0];
    const firstPath =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first
          ? ((first as Record<string, unknown>).path ??
              (first as Record<string, unknown>).file ??
              (first as Record<string, unknown>).file_path)
          : null;
    if (typeof firstPath === 'string' && firstPath) {
      return files.length === 1
        ? basename(firstPath)
        : `${basename(firstPath)} +${files.length - 1}`;
    }
    return `${files.length} changes`;
  }

  // Todo / planning tools — describe by count
  const todos = payload.todos;
  if (Array.isArray(todos)) return `${todos.length} todos`;

  return '';
}
