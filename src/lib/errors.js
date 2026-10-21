export class AppError extends Error {
  constructor(status, code, message, opts = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = !!opts.retryable;
    this.details = opts.details;
  }
}
/** Thrown when a job tries to commit after a newer attempt (or a cancel) superseded it. */
export class StaleAttemptError extends Error {
  constructor() { super('Task attempt superseded'); this.code = 'STALE_ATTEMPT'; }
}
