import { PageShell } from './PageShell';
import { RELEASE } from '../lib/release';

/**
 * Terms and Privacy, written in plain language.
 *
 * Deliberately not boilerplate: this project has no company entity, no server, and no
 * account system, so most of a standard template would be a lie. Where a real-world
 * detail genuinely does not exist, the text says so instead of inventing it.
 *
 * This is not legal advice, and the page says that too.
 */

export function Terms() {
  return (
    <PageShell
      title="Terms of Use"
      subtitle="Plain language, because terms nobody reads protect nobody."
      updated="July 2026"
    >
      <h2>1. What this covers</h2>
      <p>
        These terms cover your use of the AXIOM desktop application (version{' '}
        {RELEASE.version}) and this website. AXIOM is an independent project. There is no
        company entity behind it, no support contract, and no paid tier.
      </p>

      <h2>2. Licence</h2>
      <p>
        You may install and use AXIOM on your own machines, for personal or commercial work, at
        no cost. You may not redistribute a modified build under the AXIOM name, or present it
        as an official release.
      </p>

      <h2>3. You own your code, and you are responsible for it</h2>
      <p>
        AXIOM writes files and runs commands on your machine at your instruction. Generated code
        is <strong>yours</strong> — nothing here claims any right to it. It is also{' '}
        <strong>your responsibility</strong>:
      </p>
      <ul>
        <li>
          AI-generated code can be wrong, insecure, or subtly broken in ways that pass a test
          suite. Review it before you ship it.
        </li>
        <li>
          When you approve a command, that command runs with your user privileges. Read the
          approval dialog. It shows you the exact command for a reason.
        </li>
        <li>
          Keep your own backups and use version control. AXIOM snapshots every edit it makes,
          which is a safety net, not a backup strategy.
        </li>
        <li>
          A model may produce output resembling code it was trained on. Licence compliance for
          what you ship is on you.
        </li>
      </ul>

      <h2>4. Model providers are separate, and you pay them</h2>
      <p>
        AXIOM has no models of its own and no proxy. It sends your requests directly to the
        provider endpoint you configure — OpenAI, Anthropic, Google, an OpenAI-compatible
        gateway, or a local server. That means:
      </p>
      <ul>
        <li>Your use of each provider is governed by that provider&rsquo;s own terms.</li>
        <li>You are billed by them directly. Nothing bills you through AXIOM.</li>
        <li>
          Their availability, pricing, content policies and data handling are theirs, not ours.
          If a provider returns an error or an unexpected bill, that is between you and them.
        </li>
      </ul>

      <h2>5. Unsigned build</h2>
      <p>
        The published installer is not code-signed, so Windows SmartScreen will warn on first
        run. The SHA-256 checksum on the download page is the way to confirm you have the file
        that was published. If a checksum does not match, do not run the file.
      </p>

      <h2>6. No warranty</h2>
      <p>
        AXIOM is provided <strong>&ldquo;as is&rdquo;</strong>, without warranty of any kind,
        express or implied, including fitness for a particular purpose and non-infringement. It
        is a tool that edits files and executes commands; it can fail, and it can fail at a bad
        moment.
      </p>

      <h2>7. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, no liability is accepted for lost data, lost
        work, lost profit, provider charges you incurred, or damage caused by code AXIOM
        generated or commands it ran with your approval. You use it at your own risk. Since no
        money changes hands for AXIOM itself, there is nothing to refund.
      </p>

      <h2>8. Changes</h2>
      <p>
        These terms may change with a new release. The version and date at the top of this page
        tell you which set you are reading. Continuing to use the app after a change means you
        accept the current terms.
      </p>

      <h2>9. Contact</h2>
      <p>
        Not applicable — this project has no company entity and no support address. Issues are
        best raised wherever the project&rsquo;s source is published.
      </p>

      <p>
        <strong>This page is a plain-language summary, not legal advice.</strong> If you need a
        formal agreement for your organisation, have a lawyer look at it.
      </p>
    </PageShell>
  );
}

export function Privacy() {
  return (
    <PageShell
      title="Privacy Policy"
      subtitle="The short version: there is no AXIOM server, so there is nothing to collect."
      updated="July 2026"
    >
      <h2>The claim, stated precisely</h2>
      <p>
        AXIOM has no backend. There is no AXIOM account, no AXIOM API, and no AXIOM database.
        Nothing about you or your code is transmitted to the project&rsquo;s authors, because
        there is no server to transmit it to.
      </p>
      <p>
        That is a strong claim, so the rest of this page is specific about the one thing that{' '}
        <em>does</em> leave your machine.
      </p>

      <h2>What leaves your machine, and when</h2>
      <p>
        Exactly one kind of outbound request happens as part of normal use: the AI request you
        triggered, sent to the provider endpoint <strong>you</strong> configured.
      </p>
      <ul>
        <li>
          <strong>When:</strong> only when you send a message in Ask or Chat, start a Build run,
          or use an AI editor action. Never in the background, never on a timer.
        </li>
        <li>
          <strong>Where:</strong> only to the base URL in your provider settings. AXIOM refuses
          to send a stored key to any endpoint other than the one that key was authorised for.
        </li>
        <li>
          <strong>What:</strong> your prompt, the conversation so far, and whatever workspace
          context that surface includes — the files you attached or that retrieval selected.
          The manifest under each answer shows you exactly what was sent, and the token count.
        </li>
        <li>
          <strong>Who sees it:</strong> that provider, under their privacy policy. Read it. If
          you do not want any code leaving the machine, use a local Ollama model and nothing
          will.
        </li>
      </ul>

      <h2>API keys</h2>
      <p>
        Your keys are encrypted at rest with the Windows credential store and kept in the main
        process. They are never written to logs, never exposed to the app&rsquo;s own UI layer
        after being saved, and never included in an export or a crash report. Each key is bound
        to the exact endpoint it was saved for, so a stored key cannot be redirected to a
        different URL without you re-entering it.
      </p>

      <h2>Telemetry</h2>
      <p>
        Off by default, and opt-in per category. If you never turn it on, no usage event is ever
        recorded or sent. If you do turn it on, events are sanitised — no file contents, no
        prompts, no paths, no free text — and you can read the buffer and clear it from the app.
      </p>

      <h2>This website</h2>
      <ul>
        <li>No analytics. No Google Analytics, no Plausible, no anything.</li>
        <li>No cookies. The site sets none.</li>
        <li>No tracking pixels, no session recording, no fingerprinting.</li>
        <li>No accounts, no forms, no email capture. There is nothing here to submit.</li>
        <li>
          The download is a static file link. Nothing counts it, and nothing is logged beyond
          whatever access log the static host keeps.
        </li>
        <li>
          Two third-party requests, both for presentation only. The Google Fonts stylesheet,
          which loads the typefaces; and the background video files, which are served from a
          CloudFront CDN. Those hosts may see your IP address as part of serving the files — the
          same as on most of the web. Neither request carries anything about you, and neither is
          connected to the app.
        </li>
      </ul>

      <h2>Local files AXIOM writes</h2>
      <p>
        All app data lives in <code>%APPDATA%\@axiom\desktop</code>: your settings, encrypted
        keys, chat history, edit snapshots and a local audit log. It is yours, it stays on the
        machine, and deleting that folder deletes all of it. The Documentation page lists each
        file and what it holds.
      </p>

      <h2>Children</h2>
      <p>
        AXIOM is a developer tool and is not directed at children. It collects nothing from
        anyone, of any age.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy ever changes, the date at the top changes with it. A change that weakened
        the no-server promise would be a material change, and would be stated plainly rather
        than buried. The site&rsquo;s background video is hosted on a third-party CDN; if you
        would rather the page made no external media request at all, that is a one-file change
        and the repository&rsquo;s README explains it.
      </p>

      <h2>Contact</h2>
      <p>
        Not applicable — there is no company entity and no data controller to write to, because
        no personal data is collected.
      </p>
    </PageShell>
  );
}
