import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { SearchFileResult, SearchMatch, SearchOptions, SearchResult } from '../../common/ipc';

/**
 * Cross-file text search (Main process, PRD Part VII §105). A pragmatic,
 * dependency-free scanner: walks the workspace (skipping heavy/ignored dirs,
 * binary, empty, and large files), supports literal / whole-word / regex queries,
 * and returns capped, per-file grouped matches. A worker-thread / Rust-backed
 * indexer replaces this for scale in a later epoch.
 */
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
]);

const MAX_FILE_BYTES = 1024 * 1024; // skip files larger than 1 MB
const MAX_LINE_LEN = 5000; // cap per-line scanning (huge-line / ReDoS guard)
const MAX_FILES_WITH_MATCHES = 1000;
const MAX_TOTAL_MATCHES = 2000;
const MAX_MATCHES_PER_FILE = 50;
const PREVIEW_MAX = 240;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(query: string, options: SearchOptions): RegExp {
  let pattern = options.regex ? query : escapeRegExp(query);
  if (!options.regex && options.wholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');
}

function makePreview(
  line: string,
  matchStart: number,
  matchLength: number,
): { preview: string; start: number; length: number } {
  if (line.length <= PREVIEW_MAX) return { preview: line, start: matchStart, length: matchLength };
  const from = Math.max(0, matchStart - 40);
  const prefix = from > 0 ? '…' : '';
  const slice = line.slice(from, from + PREVIEW_MAX);
  const start = prefix.length + (matchStart - from);
  const available = Math.max(0, prefix.length + slice.length - start);
  return { preview: prefix + slice, start, length: Math.min(matchLength, available) };
}

function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes('\u0000');
}

export async function searchInFiles(
  root: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  if (query.length === 0) return { query, files: [], totalMatches: 0, truncated: false };

  let re: RegExp;
  try {
    re = buildRegex(query, options);
  } catch (e) {
    return {
      query,
      files: [],
      totalMatches: 0,
      truncated: false,
      error: e instanceof Error ? e.message : 'Invalid search pattern',
    };
  }

  const files: SearchFileResult[] = [];
  let totalMatches = 0;
  let truncated = false;

  const searchFile = async (full: string, name: string): Promise<void> => {
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return;
    const content = await fs.readFile(full, 'utf-8').catch(() => null);
    if (content === null || looksBinary(content)) return;

    const lines = content.split('\n');
    const fileMatches: SearchMatch[] = [];

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li] ?? '';
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const scan = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(scan)) !== null) {
        const len = (m[0] ?? '').length;
        if (len === 0) {
          re.lastIndex += 1; // never emit / loop on empty matches
          continue;
        }
        const win = makePreview(line, m.index, len);
        fileMatches.push({
          line: li + 1,
          column: m.index + 1,
          preview: win.preview,
          matchStart: win.start,
          matchLength: win.length,
        });
        totalMatches += 1;
        if (fileMatches.length >= MAX_MATCHES_PER_FILE || totalMatches >= MAX_TOTAL_MATCHES) {
          truncated = true;
          break;
        }
      }
      if (totalMatches >= MAX_TOTAL_MATCHES || fileMatches.length >= MAX_MATCHES_PER_FILE) break;
    }

    if (fileMatches.length > 0) {
      files.push({
        path: full,
        name,
        rel: relative(root, full).replace(/\\/g, '/'),
        matches: fileMatches,
      });
    }
  };

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_FILES_WITH_MATCHES || totalMatches >= MAX_TOTAL_MATCHES) {
      truncated = true;
      return;
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!dirents) return;
    for (const d of dirents) {
      if (files.length >= MAX_FILES_WITH_MATCHES || totalMatches >= MAX_TOTAL_MATCHES) {
        truncated = true;
        return;
      }
      if (d.isDirectory()) {
        if (!IGNORED_DIRS.has(d.name)) await walk(join(dir, d.name));
      } else if (d.isFile()) {
        await searchFile(join(dir, d.name), d.name);
      }
    }
  };

  await walk(root);
  return { query, files, totalMatches, truncated };
}
