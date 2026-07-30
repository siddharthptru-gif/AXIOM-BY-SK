/* Minimal inline SVG icon set. One optical system, no external dependency. */

interface IconProps {
  size?: number;
}

const OFFICIAL_LOGO_URL = new URL('../../../../build/logo.png', import.meta.url).href;

function stroke(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

export function Logo({ size = 20 }: IconProps) {
  return (
    <img
      className="axiom-official-logo"
      src={OFFICIAL_LOGO_URL}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function ExplorerIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M3 6a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

export function SearchIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function SourceControlIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M8.4 7.2A6 6 0 0 1 15.5 8.5M18 10.5c0 4-4 4.5-6 5" />
    </svg>
  );
}

export function RunIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.5 15.5 12 10 15.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IntelligenceIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="12" cy="5" r="2.25" />
      <circle cx="6" cy="17.5" r="2.25" />
      <circle cx="18" cy="17.5" r="2.25" />
      <path d="m10.9 7-3.8 8.3M13.1 7l3.8 8.3M8.4 17.5h7.2" />
    </svg>
  );
}


/** Meaning-based code search: a lens over related nodes, not a plain magnifier. */
export function SemanticSearchIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.2" />
      <path d="m19.5 19.5-4.2-4.2" />
      <circle cx="8.4" cy="9.1" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="8.2" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="11.2" cy="12.9" r="1.15" fill="currentColor" stroke="none" />
      <path d="M8.4 9.1 12.8 8.2M8.4 9.1l2.8 3.8M12.8 8.2l-1.6 4.7" strokeWidth="1.1" />
    </svg>
  );
}

export function GodModeIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 2.8 14.3 8l5.2 2.3-5.2 2.3-2.3 5.2-2.3-5.2-5.2-2.3L9.7 8Z" />
      <path d="M18.5 15.5 19.3 18l2.5.8-2.5.8-.8 2.5-.8-2.5-2.5-.8 2.5-.8Z" />
    </svg>
  );
}

export function ExtensionsIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <path d="M13 16.5h7M16.5 13v7" />
    </svg>
  );
}

export function AiIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9Z" />
    </svg>
  );
}

export function SettingsIcon({ size = 20 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5" />
    </svg>
  );
}

export function PinIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <line x1="12" x2="12" y1="17" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

export function MaximizeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M7 4H4v3M17 4h3v3M7 20H4v-3M17 20h3v-3" />
    </svg>
  );
}

export function RestoreIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M5 9V5h4M19 15v4h-4M6 6l4.5 4.5M18 18l-4.5-4.5" />
    </svg>
  );
}

export function ClearIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  );
}

export function CommandIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M9 7H6.5a2.5 2.5 0 1 1 2.5-2.5ZM9 7v10M15 7h2.5A2.5 2.5 0 1 0 15 4.5ZM15 7v10M9 12h6M9 17H6.5A2.5 2.5 0 1 0 9 19.5ZM15 17h2.5a2.5 2.5 0 1 1-2.5 2.5Z" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MinusIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

export function SplitIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

export function PlayIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m8.5 5.5 10 6.5-10 6.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RefreshIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M19 8a7.5 7.5 0 1 0 .2 7.6M19 4v4h-4" />
    </svg>
  );
}

export function UndoIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m9 7-5 5 5 5M5 12h8a6 6 0 0 1 6 6" />
    </svg>
  );
}

export function SparkIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5ZM19 16l.6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6Z" />
    </svg>
  );
}

export function ErrorIcon({ size = 14 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </svg>
  );
}

export function WarningIcon({ size = 14 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 4 21 20H3Z" />
      <path d="M12 9v5M12 17.25v.1" />
    </svg>
  );
}

export function PanelBottomIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 14.5h17" />
    </svg>
  );
}

export function PanelRightIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M14.5 4v16" />
    </svg>
  );
}

export function HistoryIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M4 7V3m0 0h4M4 3l3.2 3.2A8 8 0 1 1 4.4 12" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function EditIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m4 16-.8 4 4-.8L18.5 8.9l-3.4-3.4Z" />
      <path d="m13.8 6.8 3.4 3.4M4 20h16" />
    </svg>
  );
}

export function DownloadIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
      <path d="M4 19h16" />
    </svg>
  );
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

export function ToolIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M14.5 6.5a4 4 0 0 0-5-5L12 4 8 8 5.5 5.5a4 4 0 0 0 5 5L18 18a2 2 0 1 0 3-3Z" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function ShieldIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="m4 4 17 8-17 8 3-8Z" />
      <path d="M7 12h14" />
    </svg>
  );
}

export function PromptIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

export function BrainIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M9.5 5a3 3 0 0 0-5 2.2A3 3 0 0 0 5 13a3 3 0 0 0 4.5 3.8ZM14.5 5a3 3 0 0 1 5 2.2A3 3 0 0 1 19 13a3 3 0 0 1-4.5 3.8Z" />
      <path d="M9.5 5v14M14.5 5v14M7 9.5h2.5M14.5 9.5H17M7 14h2.5M14.5 14H17" />
    </svg>
  );
}

export function BalanceIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3v18M6 21h12M5 7h14" />
      <path d="m5 7-3 6h6ZM19 7l-3 6h6Z" />
    </svg>
  );
}

export function EyeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M4 4l16 16" />
      <path d="M9.5 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.4 16.4 0 0 1-3 3.6M6.5 7.6A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 2.5-.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

export function TerminalIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function FileIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M6 3h7l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M13 3v5h5" />
    </svg>
  );
}

export function FolderIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M3 6a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

export function MoveIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3v18M3 12h18M12 3 9 6m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3" />
    </svg>
  );
}

export function PackageIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3 20 7v10l-8 4-8-4V7Z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </svg>
  );
}

export function PaletteIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H13a2 2 0 0 1 0-4h5a3 3 0 0 0 3-3 7 7 0 0 0-7-7Z" />
      <circle cx="8" cy="9" r="1.1" />
      <circle cx="8" cy="14.5" r="1.1" />
      <circle cx="12" cy="7" r="1.1" />
    </svg>
  );
}

export function BeakerIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 14h9" />
    </svg>
  );
}

export function GlobeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.4 3.8 5.6 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3Z" />
    </svg>
  );
}

export function LockIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function RocketIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 11a10 10 0 0 1 9-8c1 4-1 7.5-4 10-1.7 1.4-3.5 2-3.5 2L7 13s.6-1.8 2-3Z" />
      <circle cx="14.5" cy="9.5" r="1.5" />
    </svg>
  );
}

export function PulseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  );
}

export function KeyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...stroke(size)} aria-hidden="true">
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 8 8M16 16l2-2M19 19l2-2" />
    </svg>
  );
}

/** Paperclip, for the Build composer's workspace-file reference button. */
export function PaperclipIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11.4 6.1 6.7 10.8a1.8 1.8 0 0 0 2.5 2.5l4.7-4.7a3.4 3.4 0 0 0-4.8-4.8L4 8.9a5 5 0 0 0 7 7l3.2-3.2" />
    </svg>
  );
}
