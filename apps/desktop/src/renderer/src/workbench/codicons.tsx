import type { ReactNode } from 'react';
import {
  BeakerIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClearIcon,
  CloseIcon,
  CommandIcon,
  CopyIcon,
  DownloadIcon,
  EditIcon,
  ErrorIcon,
  ExtensionsIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  HistoryIcon,
  KeyIcon,
  LockIcon,
  MinusIcon,
  PackageIcon,
  PaletteIcon,
  PaperclipIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  PulseIcon,
  RefreshIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SourceControlIcon,
  SparkIcon,
  SplitIcon,
  StopIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
  UndoIcon,
  WarningIcon,
} from './icons';

/**
 * `ThemeIcon` support (PRD Phase 5 §11).
 *
 * Extensions name icons the way VS Code does — `new vscode.ThemeIcon('git-commit')` — which
 * assumes a codicon font is loaded. AXIOM does not bundle that font, and shipping one would mean
 * shipping a 60 KB binary whose glyphs are private-use codepoints: any id it does not cover draws
 * as a replacement box. So the mapping is explicit instead.
 *
 * Two sources, in order. Most codicon ids name something AXIOM already draws, so they resolve to
 * the workbench's own icon components — a contributed tree then looks like the rest of the IDE
 * rather than like a second icon set bolted on. Ids with no AXIOM equivalent get a glyph below.
 * Anything left over falls back honestly: a neutral outline plus the id in `title` and
 * `data-codicon`, so a missing icon is visible and diagnosable rather than an invisible gap.
 */
interface IconProps {
  size?: number;
}

type IconComponent = (props: IconProps) => ReactNode;

/** Codicon id → an icon AXIOM already ships. Aliases are listed as separate keys deliberately. */
const REUSED: Readonly<Record<string, IconComponent>> = {
  add: PlusIcon,
  beaker: BeakerIcon,
  brain: BrainIcon,
  check: CheckIcon,
  'check-all': CheckIcon,
  'chevron-down': ChevronDownIcon,
  'chevron-left': ChevronLeftIcon,
  'chevron-right': ChevronRightIcon,
  'clear-all': ClearIcon,
  close: CloseIcon,
  'close-all': CloseIcon,
  command: CommandIcon,
  copy: CopyIcon,
  dash: MinusIcon,
  'debug-start': PlayIcon,
  'debug-stop': StopIcon,
  'desktop-download': DownloadIcon,
  discard: UndoIcon,
  edit: EditIcon,
  error: ErrorIcon,
  extensions: ExtensionsIcon,
  eye: EyeIcon,
  'eye-closed': EyeOffIcon,
  file: FileIcon,
  'file-code': FileIcon,
  'file-text': FileIcon,
  folder: FolderIcon,
  'folder-opened': FolderIcon,
  gear: SettingsIcon,
  globe: GlobeIcon,
  history: HistoryIcon,
  key: KeyIcon,
  lock: LockIcon,
  paintcan: PaletteIcon,
  package: PackageIcon,
  paperclip: PaperclipIcon,
  pin: PinIcon,
  play: PlayIcon,
  'primitive-square': StopIcon,
  pulse: PulseIcon,
  refresh: RefreshIcon,
  remove: MinusIcon,
  rocket: RocketIcon,
  'run-all': PlayIcon,
  search: SearchIcon,
  settings: SettingsIcon,
  'settings-gear': SettingsIcon,
  shield: ShieldIcon,
  'source-control': SourceControlIcon,
  sparkle: SparkIcon,
  'split-horizontal': SplitIcon,
  'split-vertical': SplitIcon,
  stop: StopIcon,
  'stop-circle': StopIcon,
  symbol_color: PaletteIcon,
  terminal: TerminalIcon,
  'terminal-bash': TerminalIcon,
  tools: ToolIcon,
  trash: TrashIcon,
  trashcan: TrashIcon,
  warning: WarningIcon,
  watch: HistoryIcon,
  wrench: ToolIcon,
  zap: SparkIcon,
};

/** Glyphs with no AXIOM equivalent. 24×24, stroked, so they line up with the reused set. */
const PATHS: Readonly<Record<string, readonly string[]>> = {
  account: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  archive: ['M3 5h18v4H3z', 'M5 9v10h14V9', 'M10 13h4'],
  'arrow-down': ['M12 5v14', 'm6 13 6 6 6-6'],
  'arrow-up': ['M12 19V5', 'm6 11 6-6 6 6'],
  bell: ['M18 16V11a6 6 0 1 0-12 0v5l-2 3h16z', 'M10 22h4'],
  bug: [
    'M7 10h10v4a5 5 0 0 1-10 0z',
    'M9 5h6l1 3H8z',
    'M4 12h3',
    'M17 12h3',
    'M5 19l3-3',
    'M19 19l-3-3',
  ],
  calendar: ['M4 6h16v14H4z', 'M4 11h16', 'M8 3v4', 'M16 3v4'],
  'circle-filled': ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z'],
  'circle-outline': ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'],
  cloud: ['M18 18H7a4 4 0 0 1-.7-7.94A6 6 0 1 1 18 18z'],
  'cloud-download': ['M18 15H7a4 4 0 0 1-.7-7.94A6 6 0 1 1 18 15z', 'M12 13v7', 'm9 17 3 3 3-3'],
  'cloud-upload': ['M18 15H7a4 4 0 0 1-.7-7.94A6 6 0 1 1 18 15z', 'M12 20v-7', 'm9 16 3-3 3 3'],
  'collapse-all': ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  comment: ['M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12z'],
  'comment-discussion': ['M20 4H9v9h3l3 3v-3h5z', 'M4 8v9h3l3 3v-3'],
  dashboard: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 12l4-4', 'M12 16h.01'],
  database: [
    'M12 8c5 0 9-1.3 9-3s-4-3-9-3-9 1.3-9 3 4 3 9 3z',
    'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5',
    'M3 12c0 1.7 4 3 9 3s9-1.3 9-3',
  ],
  diff: ['M4 4h16v16H4z', 'M8 9h8', 'M8 15h8', 'M12 6v6'],
  'expand-all': ['M10 6h4', 'M7 12h10', 'M4 18h16'],
  filter: ['M3 5h18l-7 8v6l-4-2v-4z'],
  filled: ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z'],
  'git-branch': [
    'M6 4v9',
    'M6 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M18 8v2a6 6 0 0 1-6 6H6',
  ],
  'git-commit': ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 12h5.5', 'M15.5 12H21'],
  'git-merge': [
    'M6 21V6',
    'M6 6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M18 15a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M15.5 12.5H12a6 6 0 0 1-6-6',
  ],
  'git-pull-request': [
    'M6 9v12',
    'M6 6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M18 22a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M18 17V9a3 3 0 0 0-3-3h-3',
    'm15 3-3 3 3 3',
  ],
  home: ['m3 11 9-7 9 7', 'M5 10v10h14V10'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 8h.01'],
  issues: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v5', 'M12 16h.01'],
  lightbulb: ['M12 3a6 6 0 0 0-3 11v3h6v-3a6 6 0 0 0-3-11z', 'M10 21h4'],
  link: ['M9 15l6-6', 'M11 7l1-1a4 4 0 0 1 6 6l-1 1', 'M13 17l-1 1a4 4 0 0 1-6-6l1-1'],
  'link-external': ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  'list-unordered': ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  mail: ['M3 5h18v14H3z', 'm3 6 9 7 9-7'],
  milestone: ['M12 3v4', 'M4 7h14l2 3-2 3H4z', 'M12 13v8'],
  notebook: ['M6 3h13v18H6z', 'M6 8H3', 'M6 12H3', 'M6 16H3'],
  organization: ['M4 20h16', 'M6 20V8h6v12', 'M12 20V4h6v16', 'M8 11h2', 'M15 8h1'],
  output: ['M4 5h16v11H4z', 'M8 20h8'],
  question: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3', 'M12 17h.01'],
  repo: ['M6 2h14v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z', 'M4 17.5h16'],
  robot: [
    'M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z',
    'M12 5v4',
    'M9 14h.01',
    'M15 14h.01',
  ],
  save: ['M5 4h11l3 3v13H5z', 'M8 4v6h8V4', 'M8 20v-6h8v6'],
  server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'],
  'sign-in': ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'm10 17 5-5-5-5', 'M15 12H3'],
  'sign-out': ['M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  star: ['M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.8l6.5-.9z'],
  tag: ['M20 12l-8 8-9-9V3h8z', 'M7.5 7.5h.01'],
  'three-bars': ['M4 6h16', 'M4 12h16', 'M4 18h16'],
};

/** Ids drawn solid rather than stroked. */
const FILLED = new Set(['circle-filled', 'filled', 'star-full']);

const ALIASES: Readonly<Record<string, string>> = {
  'arrow-circle-down': 'cloud-download',
  'arrow-circle-up': 'cloud-upload',
  bookmark: 'tag',
  'circle-large-filled': 'circle-filled',
  'circle-large-outline': 'circle-outline',
  'cloud-sync': 'cloud',
  debug: 'bug',
  'debug-alt': 'bug',
  'debug-console': 'output',
  'git-compare': 'git-pull-request',
  'git-pull-request-closed': 'git-pull-request',
  'git-pull-request-draft': 'git-pull-request',
  'github-inverted': 'repo',
  github: 'repo',
  graph: 'dashboard',
  'kebab-vertical': 'three-bars',
  ellipsis: 'three-bars',
  'list-flat': 'list-unordered',
  'list-tree': 'list-unordered',
  note: 'comment',
  person: 'account',
  'repo-clone': 'repo',
  'repo-forked': 'git-branch',
  'root-folder': 'folder',
  'star-empty': 'star',
  'star-full': 'star',
  'symbol-class': 'circle-outline',
  'symbol-field': 'circle-outline',
  'symbol-file': 'file',
  'symbol-folder': 'folder',
  'symbol-method': 'circle-outline',
  'symbol-property': 'circle-outline',
  'symbol-variable': 'circle-outline',
  'testing-failed-icon': 'error',
  'testing-passed-icon': 'check',
  'verified-filled': 'check',
  verified: 'check',
  'workspace-trusted': 'shield',
  'workspace-untrusted': 'shield',
};

/**
 * Theme colour ids → AXIOM's own tokens.
 *
 * Only the ids extensions actually use for tree decoration. An unmapped id inherits the row
 * colour, which is the safe answer: a wrong colour reads as a status the item does not have.
 */
const THEME_COLORS: Readonly<Record<string, string>> = {
  'charts.blue': 'var(--info)',
  'charts.foreground': 'var(--fg-default)',
  'charts.green': 'var(--success, var(--accent))',
  'charts.orange': 'var(--warning)',
  'charts.purple': 'var(--accent)',
  'charts.red': 'var(--danger)',
  'charts.yellow': 'var(--warning)',
  descriptionForeground: 'var(--fg-muted)',
  disabledForeground: 'var(--fg-muted)',
  errorForeground: 'var(--danger)',
  'gitDecoration.addedResourceForeground': 'var(--success, var(--accent))',
  'gitDecoration.conflictingResourceForeground': 'var(--danger)',
  'gitDecoration.deletedResourceForeground': 'var(--danger)',
  'gitDecoration.ignoredResourceForeground': 'var(--fg-muted)',
  'gitDecoration.modifiedResourceForeground': 'var(--warning)',
  'gitDecoration.untrackedResourceForeground': 'var(--success, var(--accent))',
  'list.errorForeground': 'var(--danger)',
  'list.warningForeground': 'var(--warning)',
  'notificationsErrorIcon.foreground': 'var(--danger)',
  'notificationsWarningIcon.foreground': 'var(--warning)',
  'problemsErrorIcon.foreground': 'var(--danger)',
  'problemsInfoIcon.foreground': 'var(--info)',
  'problemsWarningIcon.foreground': 'var(--warning)',
  'testing.iconErrored': 'var(--danger)',
  'testing.iconFailed': 'var(--danger)',
  'testing.iconPassed': 'var(--success, var(--accent))',
  'testing.iconQueued': 'var(--warning)',
};

/** The CSS colour for a `ThemeIcon` colour id, or undefined to inherit. */
export function themeIconColor(id: string | null): string | undefined {
  if (id === null) return undefined;
  return THEME_COLORS[id];
}

function canonical(id: string): string {
  const lower = id.toLowerCase();
  return ALIASES[lower] ?? lower;
}

/** Whether a codicon id draws as itself rather than as the fallback glyph. */
export function hasCodicon(id: string): boolean {
  const key = canonical(id);
  return key in REUSED || key in PATHS;
}

export function Codicon({
  id,
  color = null,
  size = 16,
}: {
  id: string;
  color?: string | null;
  size?: number;
}) {
  const key = canonical(id);
  const tint = themeIconColor(color);
  const style = tint === undefined ? undefined : { color: tint };
  const Reused = REUSED[key];
  if (Reused !== undefined) {
    return (
      <span className="codicon" style={style} data-codicon={key} aria-hidden="true">
        <Reused size={size} />
      </span>
    );
  }
  const paths = PATHS[key];
  const filled = FILLED.has(key);
  return (
    <span className="codicon" style={style} data-codicon={key} aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={paths !== undefined && filled ? 'currentColor' : 'none'}
        stroke={paths !== undefined && filled ? 'none' : 'currentColor'}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths === undefined ? (
          // The honest fallback: a neutral node marker. `title` and `data-codicon` name the id
          // that has no glyph, so the gap is reportable instead of silent.
          <>
            <title>{id}</title>
            <circle cx="12" cy="12" r="4.5" strokeDasharray="2 2" />
          </>
        ) : (
          paths.map((d) => <path key={d} d={d} />)
        )}
      </svg>
    </span>
  );
}
