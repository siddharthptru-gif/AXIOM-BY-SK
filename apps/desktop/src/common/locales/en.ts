import type { MessageCatalog } from '../i18n';

/**
 * Base English catalog (PRD Epoch I §95 / Phase 250). The source-of-truth strings;
 * additional locales are added as sibling catalogs without code changes. Keys are
 * dotted namespaces. `{n, plural, …}` uses the ICU subset from `common/i18n`.
 */
export const en: MessageCatalog = {
  'extensions.none': 'No extensions installed.',
  'extensions.loading': 'Loading extensions…',
  'agent.openFolder': 'Open a folder to use the agent.',
  'chat.empty': 'Ask Axiom AI about your code, errors, or an approach.',
  'chat.ask.empty':
    'Ask a grounded, read-only question about this workspace — answers cite the files they draw on.',
  'search.results': '{count, plural, =0 {No results} one {# result} other {# results}}',
  'security.findings':
    '{count, plural, =0 {No secrets found} one {# finding} other {# findings}} in {file}',
};
