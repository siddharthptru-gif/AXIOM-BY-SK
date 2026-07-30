import type { ReactNode } from 'react';
import { resolveFileIcon, resolveFolderIcon, useIconThemeKey } from './iconTheme';

/**
 * Tree / tab icons (PRD Part IX §154). A tiny, self-contained file-icon "theme":
 * a shared document glyph tinted by category with a distinguishing inner mark
 * (chevrons for code, brackets for data, text lines for prose/config), plus
 * dedicated picture and padlock glyphs. No external icon font or brand logos.
 *
 * When an extension icon theme is active it takes over, one icon at a time: a file the
 * theme has an image for gets that image, and anything it does not cover falls back to the
 * glyph below. That per-icon fallback is deliberate — icon themes are uneven, and a theme
 * that only ships logos for twenty languages should not leave every other file blank.
 *
 * Only image icons are adopted. Icon themes may also define glyphs as characters in a
 * bundled font; those are skipped rather than rendered, because without loading the font
 * the character is a private-use codepoint that draws as a replacement box.
 */
interface IconProps {
  size?: number;
}

/**
 * A themed icon rendered as an image source.
 *
 * `<img src>` and never inline markup: SVG loaded through an image source is rendered in
 * the browser's secure static mode, with scripts and external references disabled. The same
 * bytes injected into the DOM would be a live document, and these bytes come from a
 * third-party package.
 */
function ThemedIcon({ src, size }: { src: string; size: number }) {
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  );
}

export function ChevronIcon({ open, size = 16 }: IconProps & { open: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s ease' }}
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function FolderIcon({ open, size = 16 }: IconProps & { open: boolean }) {
  useIconThemeKey();
  const themed = resolveFolderIcon(open);
  if (themed?.definition.dataUrl !== undefined) {
    return <ThemedIcon src={themed.definition.dataUrl} size={size} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.6 1.6h5.4A1.5 1.5 0 0 1 17 8.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={
          open
            ? 'M3.6 9h16.2l-1.7 8.2a1.5 1.5 0 0 1-1.5 1.2H4.9a1.5 1.5 0 0 1-1.5-1.3L2.3 10.6A1.3 1.3 0 0 1 3.6 9Z'
            : 'M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z'
        }
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  );
}

// ---- File classification -------------------------------------------------
type FileVariant = 'plain' | 'code' | 'braces' | 'lines' | 'image' | 'lock';

interface FileLook {
  variant: FileVariant;
  color: string;
}

const COLOR = {
  blue: '#4aa3ff',
  amber: '#e0a94b',
  yellow: '#e5c07b',
  green: '#3fce8f',
  teal: '#2bb0a6',
  cyan: '#56b6c2',
  orange: '#e08a4b',
  red: '#ef5f6b',
  purple: '#9aa0ab',
  pink: '#e06c9f',
  gray: '#8b93a7',
} as const;

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function classify(name: string): FileLook {
  const lower = name.toLowerCase();

  if (
    lower.endsWith('.lock') ||
    lower === 'package-lock.json' ||
    lower === 'yarn.lock' ||
    lower === 'pnpm-lock.yaml'
  ) {
    return { variant: 'lock', color: COLOR.gray };
  }
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile'))
    return { variant: 'lines', color: COLOR.cyan };
  if (lower.startsWith('.git')) return { variant: 'lines', color: COLOR.orange };
  if (lower.startsWith('.env')) return { variant: 'lines', color: COLOR.amber };

  switch (extOf(name)) {
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
    case 'py':
    case 'c':
    case 'h':
    case 'cpp':
    case 'cc':
    case 'hpp':
    case 'cs':
      return { variant: 'code', color: COLOR.blue };
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return { variant: 'code', color: COLOR.amber };
    case 'rs':
    case 'swift':
      return { variant: 'code', color: COLOR.orange };
    case 'go':
      return { variant: 'code', color: COLOR.cyan };
    case 'java':
    case 'kt':
    case 'kts':
    case 'rb':
      return { variant: 'code', color: COLOR.red };
    case 'php':
      return { variant: 'code', color: COLOR.purple };
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return { variant: 'code', color: COLOR.green };
    case 'html':
    case 'htm':
    case 'xml':
    case 'vue':
    case 'svelte':
      return { variant: 'code', color: COLOR.orange };
    case 'json':
    case 'jsonc':
    case 'json5':
      return { variant: 'braces', color: COLOR.yellow };
    case 'css':
      return { variant: 'lines', color: COLOR.blue };
    case 'scss':
    case 'sass':
    case 'less':
      return { variant: 'lines', color: COLOR.pink };
    case 'md':
    case 'markdown':
    case 'mdx':
      return { variant: 'lines', color: COLOR.blue };
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'cfg':
    case 'properties':
      return { variant: 'lines', color: COLOR.teal };
    case 'csv':
    case 'tsv':
      return { variant: 'lines', color: COLOR.green };
    case 'txt':
    case 'log':
      return { variant: 'lines', color: COLOR.gray };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'ico':
    case 'bmp':
    case 'avif':
      return { variant: 'image', color: COLOR.green };
    case 'pdf':
      return { variant: 'plain', color: COLOR.red };
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
    case '7z':
      return { variant: 'plain', color: COLOR.purple };
    default:
      return { variant: 'plain', color: COLOR.gray };
  }
}

function Glyph({ color, size, children }: { color: string; size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function FileIcon({ name, size = 16 }: IconProps & { name?: string }) {
  useIconThemeKey();
  const themed = name === undefined ? null : resolveFileIcon(name);
  if (themed?.definition.dataUrl !== undefined) {
    return <ThemedIcon src={themed.definition.dataUrl} size={size} />;
  }
  const look = name ? classify(name) : { variant: 'plain' as const, color: 'currentColor' };

  if (look.variant === 'image') {
    return (
      <Glyph color={look.color} size={size}>
        <path d="M5 5.5h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
        <circle cx="9" cy="10" r="1.5" />
        <path d="m4.5 17 4-4 3 3 3.5-3.5L19 16" />
      </Glyph>
    );
  }

  if (look.variant === 'lock') {
    return (
      <Glyph color={look.color} size={size}>
        <path d="M8.5 10V8a3.5 3.5 0 1 1 7 0v2" />
        <path d="M6.75 10.5h10.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.75a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
      </Glyph>
    );
  }

  return (
    <Glyph color={look.color} size={size}>
      <path d="M6 3h7l5 5v13a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0V3Z" />
      <path d="M13 3v5h5" />
      {look.variant === 'code' ? (
        <>
          <path d="M10.2 12.9 8.9 14.3l1.3 1.4" />
          <path d="m13.8 12.9 1.3 1.4-1.3 1.4" />
        </>
      ) : null}
      {look.variant === 'braces' ? (
        <>
          <path d="M11 12.7H10v2.8h1" />
          <path d="M13 12.7h1v2.8h-1" />
        </>
      ) : null}
      {look.variant === 'lines' ? (
        <>
          <path d="M9 13h6" />
          <path d="M9 15h6" />
          <path d="M9 17h4" />
        </>
      ) : null}
    </Glyph>
  );
}
