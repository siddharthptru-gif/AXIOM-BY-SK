/** Maps a file path to a Monaco language id (PRD Part VII §106.2). */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  // .mts/.cts are ordinary TypeScript. Leaving them out made Monaco treat them as
  // plaintext, which silently disabled every language-server provider for them,
  // since providers are registered against Monaco language ids.
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  // CUDA is C++ as far as both Monaco's grammar and clangd are concerned.
  cu: 'cpp',
  cuh: 'cpp',
  m: 'objective-c',
  mm: 'objective-c',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  rake: 'ruby',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  bat: 'bat',
  ps1: 'powershell',
  lua: 'lua',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  r: 'r',
  rmd: 'r',
  json5: 'json',
  zsh: 'shell',
  fish: 'shell',
  env: 'ini',
  properties: 'ini',
  cfg: 'ini',
  conf: 'ini',
  svg: 'xml',
  xhtml: 'html',
  sass: 'css',
  styl: 'css',
  psm1: 'powershell',
  psd1: 'powershell',
  cmd: 'bat',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  zig: 'zig',
  nim: 'nim',
  txt: 'plaintext',
  log: 'plaintext',
  gitignore: 'plaintext',
  dockerignore: 'plaintext',
};

/** Files whose language is decided by their whole name, not their extension. */
const NAME_TO_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  // gopls serves these, and Monaco's Go grammar reads them acceptably. Without
  // an entry they fell through to plaintext and lost all Go tooling.
  'go.mod': 'go',
  'go.work': 'go',
  'go.sum': 'plaintext',
};

export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const byName = NAME_TO_LANG[name.toLowerCase()];
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'plaintext';
}
