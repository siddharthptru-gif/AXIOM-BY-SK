import type { MessageCatalog } from '../i18n';

/**
 * Spanish catalog (PRD Epoch I §95 / Phase 252 — first non-English locale). A
 * first, in-progress translation: most UI strings are translated; any key not yet
 * translated (e.g. `chat.ask.empty`) is intentionally omitted and falls back to
 * English via `mergeCatalog`, and shows up in the localization review queue
 * (`common/i18nCoverage`). `{n, plural, …}` uses the same ICU subset as English.
 */
export const es: MessageCatalog = {
  'extensions.none': 'No hay extensiones instaladas.',
  'extensions.loading': 'Cargando extensiones…',
  'agent.openFolder': 'Abre una carpeta para usar el agente.',
  'chat.empty': 'Pregunta a Axiom AI sobre tu código, errores o un enfoque.',
  // 'chat.ask.empty' — pending human review; falls back to English.
  'search.results': '{count, plural, =0 {Sin resultados} one {# resultado} other {# resultados}}',
  'security.findings':
    '{count, plural, =0 {Sin secretos} one {# hallazgo} other {# hallazgos}} en {file}',
};
