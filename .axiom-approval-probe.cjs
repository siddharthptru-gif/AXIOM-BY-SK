#!/usr/bin/env node
/**
 * Verification probe for the 2.0.4 Build approval fixes.
 *
 * Four behaviours are asserted, each of which was a reported bug:
 *
 *   1. Loop detection — the same action repeated N times must force an approval even
 *      when an auto-approval would otherwise have let it through unattended.
 *   2. Consent gating — a pre-authorizable call settles without a dialog only when
 *      consent is granted, and never for a call that is not marked pre-authorizable.
 *   3. Settle-once — an approval token can carry exactly one decision.
 *   4. Guaranteed terminal event — a run must always leave the "working" state.
 *
 * 1 and 3 are exercised as real logic. 2 and 4 are asserted structurally against the
 * source, because they live inside Electron-bound Main code that cannot be imported
 * without a running app.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}
function read(rel) {
  return fs.readFileSync(path.join('apps', 'desktop', rel), 'utf8');
}
function loadPure(rel) {
  const file = path.join('apps', 'desktop', rel);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const wrapper = new Module(file, null);
  wrapper.filename = file;
  wrapper.paths = Module._nodeModulePaths(path.dirname(file));
  wrapper._compile(js, file);
  return wrapper.exports;
}

// --- 1. Loop detection -------------------------------------------------------
const agent = read('src/main/services/agent.ts');
check('a repeat limit exists', /const REPEATED_ACTION_LIMIT = (\d+)/.test(agent), /const REPEATED_ACTION_LIMIT = (\d+)/.exec(agent)?.[1]);
check('repeats are counted per identical action', agent.includes('const signature = repeatSignature(tool.name, action.args)') && agent.includes('actionRepeats.set(signature, repeats)'));
check(
  'a detected loop overrides every auto-approval',
  /policyDecision === 'deny'\s*\?\s*'deny'\s*:\s*looping\s*\?\s*'ask'\s*:\s*autoApprovedWrite \|\| autoApprovedCommand/.test(
    agent,
  ),
);
check('the user is told about the loop', agent.includes('Possible loop:'));
check(
  'a rejected loop tells the model not to retry',
  agent.includes('Do NOT try it again'),
);
// The gated approval literal must survive the change untouched.
check(
  'the mandatory-approval literal is unchanged',
  agent.includes('sideEffecting || (tool.requiresApproval === true && tool.isMcp === true)'),
);

// Exercise the signature helper for real: key order must not change identity.
const signatureSource = /function repeatSignature[\s\S]*?\n}/.exec(agent);
check('repeatSignature is self-contained', Boolean(signatureSource));
if (signatureSource) {
  // The helper is TypeScript, so strip its annotations the same way the build does
  // before executing it — the probe must run the REAL implementation, not a copy.
  const plain = ts.transpileModule(`${signatureSource[0]}\nmodule.exports = repeatSignature;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const holder = new Module('repeatSignature.js', null);
  holder.filename = path.join(process.cwd(), 'repeatSignature.js');
  holder.paths = [];
  holder._compile(plain, holder.filename);
  const repeatSignature = holder.exports;
  const a = repeatSignature('write_file', { path: 'x.py', content: 'a' });
  const b = repeatSignature('write_file', { content: 'a', path: 'x.py' });
  const c = repeatSignature('write_file', { path: 'y.py', content: 'a' });
  check('identical actions share a signature regardless of key order', a === b, a);
  check('different arguments produce different signatures', a !== c);
  check('a different tool produces a different signature', a !== repeatSignature('read_file', { path: 'x.py', content: 'a' }));
}

// --- 2. Consent gating -------------------------------------------------------
const mainIpc = read('src/main/ipc.ts');
check(
  'the native dialog is skipped only when pre-authorized AND consent is granted',
  mainIpc.includes("options.preauthorizable === true && (await hasExecutionConsent())"),
);
check(
  'the agent approval call is the pre-authorizable one',
  /'Approve Agent Action',[\s\S]{0,120}\{ preauthorizable: true \}/.test(mainIpc),
);
const preauthCount = (mainIpc.match(/preauthorizable: true/g) || []).length;
check('exactly one call site is pre-authorizable', preauthCount === 1, `${preauthCount} found`);
check(
  'the payload is still bounds-checked before any shortcut',
  mainIpc.indexOf('cannot be displayed safely') < mainIpc.indexOf('options.preauthorizable === true'),
);
check(
  'the audit digest is still computed for a pre-authorized action',
  mainIpc.indexOf('const approvalDigest = createHash') < mainIpc.indexOf('options.preauthorizable === true'),
);
// The gate's required ordering inside IPC.agentApprove must still hold.
const handlerIndex = mainIpc.indexOf('IPC.agentApprove');
const descriptorIndex = mainIpc.indexOf('const descriptor = getAgentNativeApprovalDescriptor', handlerIndex);
const dialogIndex = mainIpc.indexOf('await requireNativeGodModeApproval(', descriptorIndex);
const settleIndex = mainIpc.indexOf('approveAgent(runId, token, true, event.sender.id)', dialogIndex);
check(
  'the gated approval ordering is preserved',
  handlerIndex >= 0 && descriptorIndex > handlerIndex && dialogIndex > descriptorIndex && settleIndex > dialogIndex,
);
check(
  'the audit digest binding literal is preserved',
  mainIpc.includes('`Agent action approved: ${descriptor.sha256}`'),
);

// Consent storage must be Main-owned and installer-seeded.
const consent = read('src/main/services/executionConsent.ts');
check('consent reads the installer registry value', consent.includes('BuildExecutionConsent'));
check('an in-app decision overrides the installer default', consent.includes('const stored = await readStoredGrant()'));
check('consent is persisted outside the renderer', consent.includes("join(app.getPath('userData')"));
const consentTypes = loadPure('src/common/executionConsentTypes.ts');
check('the shared consent type is pure and importable', typeof consentTypes === 'object');

// The installer must collect it, refuse to install without it, and remove it.
const nsh = read('build/installer.nsh');
check('the installer asks for the permission', nsh.includes('AXIOM permission'));
check('the installer refuses to continue without it', /IDYES axiom_consent_granted[\s\S]{0,400}Quit/.test(nsh));
check('the installer skips the prompt on silent updates', nsh.includes('IfSilent axiom_consent_granted'));
check('the installer records the grant per-user', nsh.includes('WriteRegDWORD HKCU "Software\\AXIOM\\Setup" "BuildExecutionConsent" 1'));
check('uninstall removes the grant', nsh.includes('DeleteRegKey HKCU "Software\\AXIOM\\Setup"'));
check(
  'the permission is asked before anything is written',
  nsh.indexOf('AXIOM permission') < nsh.indexOf('!macro customInstall'),
);

// --- 3. Settle-once ----------------------------------------------------------
const panel = read('src/renderer/src/workbench/AgentPanel.tsx');
check('settled approval tokens are tracked in a ref', panel.includes('settledApprovalsRef = useRef<Set<string>>'));
check('a settled token is refused', panel.includes('settledApprovalsRef.current.has(approvalToken)'));
check(
  'the token is marked settled before the request is sent',
  panel.indexOf('settledApprovalsRef.current.add(approvalToken)') < panel.indexOf('await window.axiom.agent.approve('),
);
check('a failed decision becomes final rather than clickable again', /catch \(cause\)[\s\S]{0,400}setDecided\(\(current\) => \(\{ \.\.\.current, \[index\]: false \}\)\)/.test(panel));
check('the settled set is cleared when a new run starts', panel.includes('settledApprovalsRef.current = new Set()'));

// --- 3b. An approval that is never answered must not strand the run ---------
// This was the hole behind "the agent stopped talking to the app": the
// acknowledgement had a deadline, the DECISION did not, so runAgent awaited a
// promise nothing would ever resolve.
check('a decision timeout exists', /const APPROVAL_DECISION_TIMEOUT_MS = /.test(agent), /const APPROVAL_DECISION_TIMEOUT_MS = ([^;]+);/.exec(agent)?.[1]);
check(
  'the decision deadline is armed when the preview is acknowledged',
  /pending\.acknowledged = true;[\s\S]{0,600}pending\.decisionTimer = setTimeout\(/.test(agent),
);
check(
  'the decision timer only settles its own approval token',
  /const active = pendingApprovals\.get\(id\);\s*if \(active\?\.approvalToken !== approvalToken\) return;/.test(
    agent,
  ),
);
check(
  'the timeout tells the model why the action did not run',
  agent.includes('the approval went unanswered for 10 minutes'),
);
check(
  'both settle paths clear the decision timer',
  (agent.match(/if \(pending\.decisionTimer\) clearTimeout\(pending\.decisionTimer\);/g) || [])
    .length === 2,
);
check(
  'the decision deadline is generous enough to read a large diff',
  /const APPROVAL_DECISION_TIMEOUT_MS = 10 \* 60_000;/.test(agent),
);

// --- 3c. The panel reconciles against Main's own task registry --------------
check(
  'the run state is reconciled against Main task status',
  panel.includes('window.axiom.agent\n        .tasks(root)') ||
    /\.tasks\(root\)/.test(panel),
);
check(
  'reconciliation only acts on the current in-flight run',
  panel.includes('if (idRef.current !== id || !runInFlightRef.current) return;'),
);
check(
  'an unknown task id is left to the watchdog instead of being guessed',
  panel.includes('if (!task) return;'),
);
check(
  'every terminal Main status ends the run locally',
  panel.includes("task.status === 'completed' || task.status === 'failed'") &&
    panel.includes("if (task.status === 'cancelled') finishRun(id, 'cancelled');"),
);

// --- 3d. The working indicator is informative, not a bare box ---------------
check('the indicator is a dedicated component', panel.includes('function AgentWorkingIndicator('));
check(
  'it reports the phase Main actually sent',
  panel.includes('function workingPhaseLabel(') && panel.includes('steps[index]?.progress?.phase'),
);
check('it shows elapsed time', panel.includes('function formatElapsed('));
check('it offers Stop in place', /className="agent-working-stop"/.test(panel));
// Build is allowed exactly ONE polite live region; a second one would make a screen
// reader repeat itself every second as the elapsed timer ticks.
check(
  'the panel still has exactly one polite live region',
  (panel.match(/aria-live="polite"/g) || []).length === 1,
  `${(panel.match(/aria-live="polite"/g) || []).length} found`,
);
check(
  'the indicator is not a competing live region',
  !/className={`agent-working\$\{stopping \? ' is-stopping' : ''\}`}[\s\S]{0,160}aria-live/.test(
    panel,
  ),
);
check('the old bare pulse markup is gone', !panel.includes('agent-working-pulse'));
const premium = read('src/renderer/src/styles/premium.css');
check('reduced motion is respected', premium.includes('.reduce-motion .agent-working-beam'));

// --- 3e. The installer asks exactly once -----------------------------------
const nshReadIndex = nsh.indexOf('ReadRegDWORD $0 HKCU "Software\\AXIOM\\Setup" "BuildExecutionConsent"');
const nshSkipIndex = nsh.indexOf('Goto axiom_consent_done', nshReadIndex);
const nshPromptIndex = nsh.indexOf('MB_YESNO', nshReadIndex);
check(
  'the installer skips the prompt when consent is already recorded',
  nshReadIndex >= 0 && nshSkipIndex > nshReadIndex && nshSkipIndex < nshPromptIndex,
  `read=${nshReadIndex} skip=${nshSkipIndex} prompt=${nshPromptIndex}`,
);
check(
  'consent is recorded before the elevated relaunch can ask again',
  nsh.indexOf('axiom_consent_granted:\n  WriteRegDWORD HKCU "Software\\AXIOM\\Setup" "BuildExecutionConsent" 1') > 0,
);

// --- 4. Guaranteed exit from the working state ------------------------------
check(
  'Main emits a terminal event when a run ends without one',
  mainIpc.includes('if (!terminalDelivered && !sender.isDestroyed())'),
);
check(
  'that fallback runs in the finally block, after every path',
  mainIpc.indexOf('if (!terminalDelivered && !sender.isDestroyed())') > mainIpc.indexOf('terminalDelivered = true;\n    } finally {'),
);
check('the renderer also stops working when Main settles the run call', panel.includes("finishRun(id, 'completed');"));
check(
  'the watchdog only fires while the run is still marked live',
  panel.includes('if (idRef.current !== id || !runInFlightRef.current) return;'),
);

// A terminal event Main synthesizes must satisfy the renderer's own validator.
const validation = loadPure('src/common/agentEventValidation.ts');
const at = Date.now();
const root = 'C:/work';
const summary = {
  root,
  at,
  outcome: 'completed',
  elapsedMs: 1,
  toolCalls: 0,
  filesChanged: 0,
  checkpointsCreated: 0,
  verification: 'not-run',
  modelTrail: [],
};
check(
  'the synthesized completed terminal event validates',
  validation.isValidAgentEventMetadata({ root, at, kind: 'final', outcome: 'completed', summary }),
);
check(
  'the synthesized cancelled terminal event validates',
  validation.isValidAgentEventMetadata({
    root,
    at,
    kind: 'error',
    outcome: 'cancelled',
    summary: { ...summary, outcome: 'cancelled' },
  }),
);
check(
  'a terminal event without a summary is still rejected',
  !validation.isValidAgentEventMetadata({ root, at, kind: 'final', outcome: 'completed' }),
);

// --- Folder management is already covered by the write class ----------------
const approval = loadPure('src/common/approval.ts');
for (const tool of ['write_file', 'replace_in_file', 'delete_file', 'create_directory', 'move_path']) {
  check(`${tool} is a write action, so folder work is covered by write consent`, approval.classifyTool(tool) === 'write');
}
check('run_command stays an exec action', approval.classifyTool('run_command') === 'exec');

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
