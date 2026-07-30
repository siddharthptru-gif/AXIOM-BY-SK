/**
 * @axiom/shared — the shared kernel.
 * PRD Part II §15.4: Result/error types, logger, ids, time, cancellation;
 * zero heavy dependencies; consumed by every process tier.
 */
export { ok, err, isOk, isErr, unwrap, unwrapOr, mapResult, mapError } from './result';
export type { Result } from './result';

export { StructuredError, toStructuredError } from './errors';
export type { ErrorSeverity, ErrorCategory, StructuredErrorProps } from './errors';

export { Logger, rootLogger, consoleSink, redact, redactString } from './logger';
export type { LogLevel, LogRecord, LogSink, LoggerOptions } from './logger';

export { generateId, shortId } from './ids';
export { now, isoNow, monotonicNow, sleep } from './time';

export { CancellationTokenSource, CancellationError } from './cancellation';
export type { CancellationToken } from './cancellation';

/** Product-level constants. */
export const PRODUCT_NAME = 'Axiom';
export const PRODUCT_TAGLINE = 'Think. Build. Ship.';
