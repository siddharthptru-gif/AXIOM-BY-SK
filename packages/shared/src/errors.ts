/**
 * Structured error model + taxonomy.
 * PRD Part II §22 and Part V §63.7: stable codes, categories, severity,
 * retryable flag, correlation id, user-safe messages.
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

export type ErrorCategory =
  | 'UserInput'
  | 'Provider'
  | 'Network'
  | 'Filesystem'
  | 'Permission'
  | 'Auth'
  | 'Internal'
  | 'Extension'
  | 'Canceled';

export interface StructuredErrorProps {
  /** Stable, machine-readable code, e.g. "provider/rate_limit". */
  code: string;
  /** User-safe, human-readable message. */
  message: string;
  category: ErrorCategory;
  severity?: ErrorSeverity;
  retryable?: boolean;
  correlationId?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class StructuredError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(props: StructuredErrorProps) {
    super(props.message, props.cause !== undefined ? { cause: props.cause } : undefined);
    this.name = 'StructuredError';
    this.code = props.code;
    this.category = props.category;
    this.severity = props.severity ?? 'error';
    this.retryable = props.retryable ?? false;
    this.correlationId = props.correlationId;
    this.details = props.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      correlationId: this.correlationId,
      details: this.details,
    };
  }
}

/** Normalizes any thrown value into a StructuredError. */
export function toStructuredError(
  e: unknown,
  fallback?: Partial<StructuredErrorProps>,
): StructuredError {
  if (e instanceof StructuredError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new StructuredError({
    code: fallback?.code ?? 'internal/unknown',
    message: fallback?.message ?? message,
    category: fallback?.category ?? 'Internal',
    severity: fallback?.severity ?? 'error',
    retryable: fallback?.retryable ?? false,
    cause: e,
    ...(fallback?.correlationId !== undefined ? { correlationId: fallback.correlationId } : {}),
    ...(fallback?.details !== undefined ? { details: fallback.details } : {}),
  });
}
