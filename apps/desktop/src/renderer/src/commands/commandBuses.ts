export type AiDockCommand = 'focus-build' | 'new-build' | 'stop-build' | 'start-god-mode';

export interface GodModeAgentLaunch {
  jobId: string;
  root: string;
  task: string;
  maxIterations: number;
  resumeRunId?: string;
}

export interface AiDockCommandAcknowledgement {
  accepted: boolean;
  reason?: string;
}

export interface AiDockCommandRequest {
  sequence: number;
  command: AiDockCommand;
  launch?: GodModeAgentLaunch;
  acknowledge: (result: AiDockCommandAcknowledgement) => void;
}

type AiDockCommandHandler = (request: AiDockCommandRequest) => void;

const MAX_PENDING_AI_COMMANDS = 8;
const AI_COMMAND_ACK_TIMEOUT_MS = 15_000;
let aiSequence = 0;
let aiHandler: AiDockCommandHandler | null = null;
let pendingAiCommands: AiDockCommandRequest[] = [];

function deliverAiCommand(owner: AiDockCommandHandler, request: AiDockCommandRequest): void {
  try {
    owner(request);
  } catch (error) {
    request.acknowledge({
      accepted: false,
      reason: error instanceof Error ? error.message : 'The AI dock rejected the command.',
    });
  }
}

function flushAiCommands(): void {
  const owner = aiHandler;
  if (!owner || pendingAiCommands.length === 0) return;
  const queued = pendingAiCommands;
  pendingAiCommands = [];
  for (const request of queued) deliverAiCommand(owner, request);
}

/** Queue an AI dock command and resolve only after its owning panel accepts or rejects it. */
export function requestAiDockCommand(
  command: AiDockCommand,
  launch?: GodModeAgentLaunch,
): Promise<AiDockCommandAcknowledgement> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: AiDockCommandAcknowledgement): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        settle({
          accepted: false,
          reason: 'The Build panel did not acknowledge the command in time.',
        }),
      AI_COMMAND_ACK_TIMEOUT_MS,
    );
    const request: AiDockCommandRequest = {
      sequence: ++aiSequence,
      command,
      ...(launch ? { launch } : {}),
      acknowledge: settle,
    };
    if (aiHandler) {
      deliverAiCommand(aiHandler, request);
      return;
    }
    const queued = [...pendingAiCommands, request];
    while (queued.length > MAX_PENDING_AI_COMMANDS) {
      queued.shift()?.acknowledge({
        accepted: false,
        reason: 'The queued AI command was superseded before Build became available.',
      });
    }
    pendingAiCommands = queued;
  });
}

/** AiView owns the sole dock command handler. */
export function setAiDockCommandHandler(handler: AiDockCommandHandler): () => void {
  aiHandler = handler;
  flushAiCommands();
  return () => {
    if (aiHandler === handler) aiHandler = null;
  };
}

export type ScmCommand =
  'view' | 'refresh' | 'fetch' | 'pull' | 'push' | 'commit-and-push' | 'connect' | 'disconnect';
type ScmCommandHandler = (command: ScmCommand) => void | Promise<void>;

interface ScmHandlerRegistration {
  version: number;
  handler: ScmCommandHandler;
}

const MAX_PENDING_SCM_COMMANDS = 16;
let scmHandler: ScmHandlerRegistration | null = null;
let scmHandlerVersion = 0;
let pendingScmCommands: ScmCommand[] = [];
let scmDelivery: Promise<void> = Promise.resolve();
let scmDraining = false;

function flushScmCommands(): void {
  if (scmDraining || !scmHandler || pendingScmCommands.length === 0) return;
  scmDraining = true;
  scmDelivery = scmDelivery
    .catch(() => undefined)
    .then(async () => {
      while (pendingScmCommands.length > 0) {
        const candidate = scmHandler;
        if (!candidate) return;
        // Yield behind any disposal/registration already queued in this turn,
        // then re-resolve ownership before removing the command from the queue.
        await Promise.resolve();
        if (scmHandler !== candidate || scmHandler.version !== candidate.version) continue;
        const command = pendingScmCommands[0];
        if (!command) return;
        pendingScmCommands = pendingScmCommands.slice(1);
        try {
          await candidate.handler(command);
        } catch {
          // One delivered command must not strand later commands.
        }
      }
    })
    .finally(() => {
      scmDraining = false;
      if (scmHandler && pendingScmCommands.length > 0) flushScmCommands();
    });
}

/** Queue a source-control command until task 5's SCM owner is mounted and ready. */
export function requestScmCommand(command: ScmCommand): void {
  pendingScmCommands = [...pendingScmCommands, command].slice(-MAX_PENDING_SCM_COMMANDS);
  flushScmCommands();
}

/** ScmView owns the sole versioned SCM command handler. */
export function setScmCommandHandler(handler: ScmCommandHandler): () => void {
  const registration = { version: ++scmHandlerVersion, handler };
  scmHandler = registration;
  flushScmCommands();
  return () => {
    if (scmHandler !== registration) return;
    scmHandlerVersion += 1;
    scmHandler = null;
  };
}
