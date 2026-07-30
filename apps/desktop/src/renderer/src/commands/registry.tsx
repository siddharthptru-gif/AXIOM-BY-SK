import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { notifyError } from '../notifications/bus';

/**
 * Command registry (PRD Part VII §103). A single, extensible place where any part
 * of the workbench contributes named actions. The Command Palette lists them and
 * keybindings/menus invoke them by id. Features register on mount and clean up on
 * unmount, so the palette always reflects what is currently available.
 */
export interface Command {
  /** Stable, namespaced id, e.g. `workbench.action.files.save`. */
  id: string;
  /** Human title shown in the palette. */
  title: string;
  /** Optional grouping label shown before the title. */
  category?: string;
  /** Live predicates used consistently by palette, menus, keybindings, and execution. */
  enabled?: () => boolean;
  visible?: () => boolean;
  disabledReason?: () => string;
  run: () => void | Promise<void>;
}

interface CommandRegistryValue {
  register: (command: Command) => void;
  unregister: (id: string) => void;
  getCommands: () => Command[];
  runCommand: (id: string) => void;
  /** Record a command as recently used (for palette MRU ordering). */
  markRecent: (id: string) => void;
  /** Recently used command ids, most-recent first. */
  getRecentCommandIds: () => string[];
}

const CommandRegistryContext = createContext<CommandRegistryValue | null>(null);

export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const commands = useRef<Map<string, Command>>(new Map());

  const register = useCallback((command: Command) => {
    commands.current.set(command.id, command);
  }, []);

  const unregister = useCallback((id: string) => {
    commands.current.delete(id);
  }, []);

  const getCommands = useCallback(() => [...commands.current.values()], []);

  const runCommand = useCallback((id: string) => {
    const command = commands.current.get(id);
    if (!command) {
      notifyError('Command is not available', { source: 'Workbench', detail: id });
      return;
    }
    if (command.visible?.() === false) {
      notifyError('Command is not available', {
        source: 'Workbench',
        detail: command.disabledReason?.() ?? id,
      });
      return;
    }
    if (command.enabled?.() === false) {
      notifyError(`Command unavailable: ${command.title}`, {
        source: 'Workbench',
        detail: command.disabledReason?.() ?? 'The current workbench state does not support it.',
      });
      return;
    }
    try {
      const result = command.run();
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          notifyError(`Command failed: ${command.title}`, {
            source: 'Workbench',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      notifyError(`Command failed: ${command.title}`, {
        source: 'Workbench',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const recentIds = useRef<string[]>([]);
  const markRecent = useCallback((id: string) => {
    recentIds.current = [id, ...recentIds.current.filter((x) => x !== id)].slice(0, 50);
  }, []);
  const getRecentCommandIds = useCallback(() => recentIds.current, []);

  const value = useMemo<CommandRegistryValue>(
    () => ({ register, unregister, getCommands, runCommand, markRecent, getRecentCommandIds }),
    [register, unregister, getCommands, runCommand, markRecent, getRecentCommandIds],
  );

  return (
    <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>
  );
}

export function useCommandRegistry(): CommandRegistryValue {
  const ctx = useContext(CommandRegistryContext);
  if (!ctx) throw new Error('useCommandRegistry must be used within CommandRegistryProvider');
  return ctx;
}

/**
 * Registers a set of commands for the lifetime of the calling component. Ids,
 * titles, and categories are captured at mount, but each `run` is resolved fresh
 * on every invocation — so handlers may safely read live context values (e.g.
 * the active file) without capturing stale mount-time state. Assumes a stable set
 * of command ids across renders (titles/categories are read once).
 */
export function useCommands(commandList: Command[]): void {
  const { register, unregister } = useCommandRegistry();
  const ref = useRef(commandList);
  ref.current = commandList;

  useEffect(() => {
    const ids = ref.current.map((c) => c.id);
    for (const command of ref.current) {
      const { id, title, category } = command;
      const wrapper: Command = {
        id,
        title,
        enabled: () => ref.current.find((c) => c.id === id)?.enabled?.() ?? true,
        visible: () => ref.current.find((c) => c.id === id)?.visible?.() ?? true,
        disabledReason: () =>
          ref.current.find((c) => c.id === id)?.disabledReason?.() ??
          'The current workbench state does not support it.',
        run: () => ref.current.find((c) => c.id === id)?.run(),
      };
      if (category !== undefined) wrapper.category = category;
      register(wrapper);
    }
    return () => {
      for (const id of ids) unregister(id);
    };
  }, [register, unregister]);
}
