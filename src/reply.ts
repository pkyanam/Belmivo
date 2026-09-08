import { basename, extname, isAbsolute } from 'node:path';
import { linkedArtifacts } from './artifacts.js';

export interface ReplyFormatOptions { artifactsDir?: string; mediaSupported: boolean; maxTextChars?: number }
export interface FormattedReply { text: string; files: string[] }
const INPUT_LIMIT = 1_048_576;
const MAX_FILES = 5;
const ASCII_PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/;
const MEDIA_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.txt', '.md', '.csv', '.json', '.docx', '.xlsx', '.pptx', '.mp3', '.m4a', '.wav', '.mp4']);
const DUNDER = /^__(?:init|new|name|main|file|path|dict|class|str|repr|all|doc|version|future|slots|getattr|setattr|getitem|setitem|iter|next|len|enter|exit|call|eq|hash|del|import)__$/;

function safeSlice(text: string, limit: number): string {
  const result = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}

/** Conservative emphasis conversion: word-internal underscores/operators stay intact. */
function prose(text: string): string {
  return text
    .replace(/(?<![\w*])\*\*\*(?=\S)([^*\n]*\S)\*\*\*(?![\w*])/g, '$1')
    .replace(/(?<![\w*])\*\*(?=\S)([^*\n]*\S)\*\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])__(?=\S)([^_\n]*\S)__(?![\w_])/g, (whole, content: string) => DUNDER.test(whole) ? whole : content)
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_\n]*\S)_(?![\w_])/g, '$1');
}

interface Link { end: number; image: boolean; label: string; destination: string }
interface Budget { remaining: number }

/** Small bounded Markdown link parser, including balanced or escaped parentheses. */
function readLink(text: string, start: number, budget: Budget): Link | undefined {
  const image = text[start] === '!';
  let cursor = start + (image ? 2 : 1), nesting = 1, label = '';
  const stop = Math.min(text.length, start + 12288);
  const step = () => cursor < stop && --budget.remaining >= 0;
  while (step()) {
    const char = text[cursor++]!;
    if (char === '\\' && cursor < stop) { label += text[cursor++]!; continue; }
    if (char === '[') { if (++nesting > 8) return; }
    if (char === ']' && --nesting === 0) break;
    label += char;
    if (label.length > 2048) return;
  }
  if (nesting !== 0 || text[cursor++] !== '(') return;
  while (text[cursor] === ' ' || text[cursor] === '\t') { if (!step()) return; cursor++; }
  // Single-line title grammar shared by angle and bare destinations. A failed
  // probe leaves bare filenames with spaces or balanced parentheses intact.
  const readTail = (start: number): number | undefined => {
    let position = start;
    const advance = () => position < stop && --budget.remaining >= 0;
    while (text[position] === ' ' || text[position] === '\t') { if (!advance()) return; position++; }
    if (text[position] === ')') return position + 1;
    const opening = text[position], closing = opening === '(' ? ')' : opening;
    if (position === start || (opening !== '"' && opening !== "'" && opening !== '(')) return;
    position++;
    let closed = false;
    while (advance()) {
      const char = text[position++]!;
      if (char === '\\' && ASCII_PUNCTUATION.test(text[position] ?? '')) { position++; continue; }
      if (char === closing) { closed = true; break; }
      if (/[\x00-\x08\x0a-\x1f]/.test(char) || (opening === '(' && char === '(')) return;
    }
    if (!closed) return;
    while (text[position] === ' ' || text[position] === '\t') { if (!advance()) return; position++; }
    if (text[position] === ')') return position + 1;
  };
  let destination = '';
  if (text[cursor] === '<') {
    cursor++;
    while (step() && text[cursor] !== '>') {
      const char = text[cursor++]!;
      // CommonMark escapes apply inside angle destinations as well as bare ones.
      if (char === '\\' && ASCII_PUNCTUATION.test(text[cursor] ?? '')) destination += text[cursor++]!;
      else { if (char === '<') return; destination += char; }
      if (destination.length > 8192) return;
    }
    if (text[cursor++] !== '>') return;
    const end = readTail(cursor);
    if (end === undefined) return;
    cursor = end;
  } else {
    let depth = 1;
    while (step()) {
      const char = text[cursor++]!;
      if (depth === 1 && (char === ' ' || char === '\t')) {
        const end = readTail(cursor - 1);
        if (end !== undefined) { cursor = end; depth = 0; break; }
      }
      if (char === '\\' && ASCII_PUNCTUATION.test(text[cursor] ?? '')) { destination += text[cursor++]!; continue; }
      if (char === '(' && ++depth > 16) return;
      if (char === ')' && --depth === 0) break;
      destination += char;
      if (destination.length > 8192) return;
    }
    if (depth !== 0) return;
  }
  destination = destination.trim();
  if (!destination || destination.length > 8192 || /[\x00-\x1f]/.test(destination)) return;
  return { end: cursor, image, label, destination };
}

/** Text and attachment candidates are derived together from the original reply. */
export function formatReply(raw: string, options: ReplyFormatOptions): FormattedReply {
  const source = safeSlice(raw, INPUT_LIMIT).replace(/\r\n/g, '\n');
  const files: string[] = [], selected = new Set<string>(), budget: Budget = { remaining: source.length * 8 + 1 };
  // Pick a sentinel absent from untrusted input, without random state or repeated
  // whole-input scans. Protected code/URLs can then sit inside outer emphasis.
  const usedSentinels = new Set([...source.matchAll(/\0(\d+)\0/g)].map(match => match[1]!));
  let sentinelId = 0; while (usedSentinels.has(String(sentinelId))) sentinelId++;
  const sentinel = `\0${sentinelId}\0`, protectedText: string[] = [];
  const protect = (value: string) => `${sentinel}${protectedText.push(value) - 1}${sentinel}`;
  const restore = (value: string) => value.replace(new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g'), (_whole, index: string) => protectedText[Number(index)]!);
  let fence: { marker: string; length: number } | undefined;
  const rendered = source.split('\n').map(line => {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) { fence = undefined; return undefined; }
      return line;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1]![0] === '`' && opening[2]!.includes('`'))) { fence = { marker: opening[1]![0]!, length: opening[1]!.length }; return undefined; }
    if (/^(?: {4}|\t)/.test(line)) return line;
    line = line.replace(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/, '$1');
    if (/^ {0,3}(?:\*\s*){3,}$/.test(line) || /^ {0,3}(?:-\s*){3,}$/.test(line) || /^ {0,3}(?:_\s*){3,}$/.test(line)) return '';
    let output = '', plain = '';
    const flush = () => { output += plain; plain = ''; };
    for (let cursor = 0; cursor < line.length;) {
      const char = line[cursor]!;
      if (char === '`') {
        let width = 1; while (line[cursor + width] === '`') width++;
        const marker = '`'.repeat(width), end = line.indexOf(marker, cursor + width);
        if (end >= 0 && end - cursor <= 8192 && line[end + width] !== '`') { flush(); output += protect(line.slice(cursor + width, end)); cursor = end + width; continue; }
        plain += marker; cursor += width; continue;
      }
      if ((char === '[' || (char === '!' && line[cursor + 1] === '[')) && budget.remaining > 0) {
        const link = readLink(line, cursor, budget);
        if (link) {
          flush();
          const label = prose(link.label.replace(/`([^`]+)`/g, '$1'));
          if (isAbsolute(link.destination)) {
            // Reuse the existing root-confinement policy with angle syntax so
            // parentheses and spaces do not change candidate interpretation.
            const candidates = !link.destination.includes('>') && MEDIA_EXTENSIONS.has(extname(link.destination).toLowerCase())
              ? linkedArtifacts(`[artifact](<${link.destination}>)`, options.artifactsDir) : [];
            const candidate = candidates[0];
            const attached = options.mediaSupported && candidate && (selected.has(candidate) || files.length < MAX_FILES);
            if (attached && !selected.has(candidate)) { selected.add(candidate); files.push(candidate); }
            const localLabel = label && !isAbsolute(label) ? label : basename(link.destination);
            output += protect(attached ? (link.image ? '' : localLabel) : `${localLabel || basename(link.destination)} (on your Mac)`);
          } else if (/^https?:\/\//i.test(link.destination)) {
            output += protect(!label || label === link.destination ? link.destination : `${label} (${link.destination})`);
          } else {
            // Relative/unknown schemes are labels, never file-send candidates.
            output += protect(label || link.destination);
          }
          cursor = link.end; continue;
        }
      }
      if (line.startsWith('http://', cursor) || line.startsWith('https://', cursor) || ((char === '/' || line.startsWith('~/', cursor)) && (cursor === 0 || /[\s(]/.test(line[cursor - 1]!)))) {
        flush();
        let end = cursor; while (end < line.length && !/\s/.test(line[end]!)) end++;
        output += protect(line.slice(cursor, end)); cursor = end; continue;
      }
      plain += char; cursor++;
    }
    flush(); return restore(prose(output));
  }).filter((line): line is string => line !== undefined).join('\n');
  const limit = options.maxTextChars === undefined ? INPUT_LIMIT : options.maxTextChars;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > INPUT_LIMIT) throw new Error('Reply text limit must be an integer between 0 and 1048576');
  return { text: safeSlice(rendered, limit), files };
}
