import { PageShell } from './PageShell';
import { RELEASE, RELEASE_SIZE, VERIFY_COMMAND } from '../lib/release';

/**
 * Real documentation, not a placeholder. Everything here describes behaviour the app
 * actually has — including the failure modes, because a docs page that only covers the
 * happy path sends people to a forum the moment anything goes wrong.
 */
export function Docs() {
  return (
    <PageShell
      title="Documentation"
      subtitle="Install AXIOM, point it at a model, and get your first change on disk. Roughly five minutes."
      updated="July 2026"
    >
      <h2>Install</h2>
      <ol>
        <li>
          Download <code>{RELEASE.fileName}</code> ({RELEASE_SIZE}).
        </li>
        <li>
          Optional but recommended — verify it. Open Command Prompt in your Downloads folder:
        </li>
      </ol>
      <pre>
        <code>{VERIFY_COMMAND}</code>
      </pre>
      <p>
        The printed hash must match <code>{RELEASE.sha256}</code>, ignoring case.
      </p>
      <ol start={3}>
        <li>
          Run the installer. This build is <strong>unsigned</strong>, so Windows SmartScreen
          will show &ldquo;Windows protected your PC&rdquo;. Choose{' '}
          <strong>More info → Run anyway</strong>. If that is not acceptable to you, verify the
          checksum above first — that is exactly what it is for.
        </li>
        <li>
          The wizard lets you choose the install location and whether to create shortcuts. It
          installs per-user by default, so no administrator prompt is required.
        </li>
      </ol>

      <h2>First run</h2>
      <p>
        AXIOM opens on a welcome view. Nothing is asked of you: there is no account, no sign-in,
        no licence key and no trial. Two things get you working:
      </p>
      <ol>
        <li>
          <strong>Open a folder.</strong> File → Open Folder, or the button on the welcome view.
        </li>
        <li>
          <strong>Trust the folder.</strong> AXIOM asks once, in a native dialog, whether you
          trust the authors of the files in it. Trust is what allows terminals, tasks, agents,
          debuggers, language servers and extensions to run. It is remembered per folder.
        </li>
      </ol>
      <p>
        Until a folder is trusted, AXIOM stays read-only in it. That is deliberate: opening a
        repository you just cloned should never be able to execute anything.
      </p>

      <h2>Configure a provider</h2>
      <p>
        AXIOM has no built-in model and takes no cut. You supply an endpoint and a key, and it
        talks directly to that endpoint. Open the AI panel and choose{' '}
        <strong>Provider Settings</strong>.
      </p>

      <h3>OpenAI, Anthropic, or Gemini</h3>
      <p>
        Pick the provider, paste your API key, and choose a model. The key is encrypted with the
        Windows credential store and is bound to that provider&rsquo;s endpoint — it cannot be
        replayed against a different URL.
      </p>

      <h3>Any OpenAI-compatible gateway</h3>
      <p>
        Choose <strong>Custom (OpenAI-Compatible)</strong> and enter the base URL — it usually
        ends in <code>/v1</code>. Press <strong>Fetch Models</strong> to list what the endpoint
        actually serves, pick one, then <strong>Test Connection</strong>. The test does two
        things: it confirms the endpoint and key work, and it sends one tiny completion to prove
        the selected model can actually answer. A gateway that lists a model it cannot serve
        fails the test rather than failing later in the middle of your work.
      </p>

      <h3>Ollama — fully local, no key</h3>
      <p>
        Install Ollama and pull a model (<code>ollama pull llama3.2</code>). AXIOM detects the
        loopback server automatically. Nothing leaves your machine at all in this mode.
      </p>

      <h2>Ask and Build</h2>
      <p>There are two AI surfaces, and the difference matters.</p>
      <h3>Ask</h3>
      <p>
        A conversation about the workspace you have open. It grounds its answer in your files
        and cites them. It has <strong>no tools</strong> — it cannot create, edit or delete
        anything, and it cannot run a command. If you ask Ask to build something, it will tell
        you to switch to Build, because that is the honest answer.
      </p>
      <h3>Build</h3>
      <p>
        An agent. It inspects the workspace, writes files, runs commands, and reports what it
        did. Each step appears in the transcript: the tool it used, the diff it produced, and
        for a command, the command itself with its exit code and captured output.
      </p>
      <p>
        Describe an outcome rather than a procedure. &ldquo;Add a dark mode toggle that persists
        to localStorage&rdquo; works better than &ldquo;create a file called theme.ts&rdquo;.
      </p>

      <h2>Permissions: trusting a folder and allowing edits</h2>
      <p>These are two separate decisions, and both are yours.</p>
      <ul>
        <li>
          <strong>Folder trust</strong> is granted once per folder and remembered. It allows
          execution at all.
        </li>
        <li>
          <strong>Edit permission</strong> controls whether each individual file write needs
          your approval. By default every write shows you a diff first. In the Build composer
          you can tick the box to allow edits for the session, or press{' '}
          <strong>Always allow in this folder</strong> to remember it across restarts.
        </li>
      </ul>
      <p>
        Allowing edits never allows anything else. Running a command, a Git push, a network
        write, an MCP tool call and any action classed as high-risk still ask you every single
        time, in a native dialog that shows the exact thing about to happen. That boundary is
        not configurable, because arbitrary command execution is the one action you cannot undo
        from a snapshot.
      </p>

      <h2>Reverting a change</h2>
      <p>Every file AXIOM writes is snapshotted first. Three ways back:</p>
      <ul>
        <li>
          <strong>The review bar</strong> at the end of a Build turn: &ldquo;N files
          changed&rdquo; with <strong>Review edits</strong>, <strong>Accept all files</strong>{' '}
          and <strong>Reject edits</strong>. Rejecting restores every file that turn touched.
        </li>
        <li>
          <strong>Inline review</strong> in the editor: each AI change is decorated in the file
          itself, and you can accept or revert one hunk at a time.
        </li>
        <li>
          <strong>Timeline / Checkpoints</strong>: the full history of snapshots, with a diff
          against what is on disk right now, and a two-step restore that names every file it
          will rewrite.
        </li>
      </ul>
      <p>
        A file you edited yourself after AXIOM wrote it is left untouched by a revert rather
        than being clobbered.
      </p>

      <h2>Keyboard shortcuts</h2>
      <ul>
        <li>
          <code>Ctrl+Shift+P</code> — command palette
        </li>
        <li>
          <code>Ctrl+P</code> — go to file
        </li>
        <li>
          <code>Ctrl+B</code> / <code>Ctrl+J</code> / <code>Ctrl+`</code> — sidebar / panel /
          terminal
        </li>
        <li>
          <code>Ctrl+S</code> — save
        </li>
        <li>
          <code>F2</code> — rename symbol
        </li>
        <li>
          <code>Shift+Alt+F</code> — format document
        </li>
        <li>
          <code>Enter</code> sends in the AI composer, <code>Shift+Enter</code> adds a line
        </li>
      </ul>
      <p>Every binding is remappable from the Keyboard Shortcuts view.</p>

      <h2>Where your data lives</h2>
      <p>Everything is on your machine, under your user profile:</p>
      <pre>
        <code>{`%APPDATA%\\@axiom\\desktop\\
  settings.json          your preferences and provider config
  secrets.json           API keys, encrypted with the OS keychain
  write-consent.json     folders you allowed edits in
  workspace-trust.json   folders you trusted
  ai-conversations.json  chat history
  snapshots/             checkpoints for every AI edit
  audit-log.jsonl        hash-chained local audit log`}</code>
      </pre>
      <p>
        To wipe AXIOM completely, uninstall it and delete that folder. There is no server-side
        copy of any of it.
      </p>

      <h2>Troubleshooting</h2>
      <h3>SmartScreen blocks the installer</h3>
      <p>
        Expected — the build is unsigned. Verify the SHA-256 first, then{' '}
        <strong>More info → Run anyway</strong>.
      </p>
      <h3>HTTP 401 or 403</h3>
      <p>
        The endpoint rejected your key. Re-enter it in Provider Settings. Keys are bound to the
        exact endpoint they were saved for, so if you changed the base URL you must re-enter the
        key to authorise the new one.
      </p>
      <h3>HTTP 429</h3>
      <p>
        You hit the provider&rsquo;s rate limit. AXIOM backs off and retries on its own. If it
        keeps happening, your tier is the limit — configure a fallback provider so it can route
        around a saturated one.
      </p>
      <h3>HTTP 500, or &ldquo;the provider could not complete the request&rdquo;</h3>
      <p>
        This is a failure inside the provider or its upstream, not in AXIOM. The error now
        includes the provider&rsquo;s own reason. It happens most often on aggregator gateways
        that advertise a large model catalogue but cannot currently serve every entry in it. Try
        a different model; if a different model works, the endpoint is fine and that one route
        is broken.
      </p>
      <h3>Fetch Models returns nothing</h3>
      <p>
        The base URL is probably missing its version segment. Most OpenAI-compatible gateways
        need to end in <code>/v1</code>.
      </p>
      <h3>Build replies with an explanation instead of editing files</h3>
      <p>
        Check you are in <strong>Build</strong> and not <strong>Ask</strong> or{' '}
        <strong>Chat</strong> — those two have no tools by design. If you are in Build, the
        model is likely too small to drive a tool loop reliably; a mid-size model will behave
        far better than a small local one for agent work.
      </p>

      <h2>Uninstalling</h2>
      <p>
        Settings → Apps → Installed apps → AXIOM → Uninstall. Your data folder is left in place
        so a reinstall keeps your settings; delete{' '}
        <code>%APPDATA%\@axiom\desktop</code> if you want it gone.
      </p>
    </PageShell>
  );
}
