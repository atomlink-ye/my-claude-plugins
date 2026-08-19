export type CompanionErrorCode =
  | 'missing_field'
  | 'invalid_value'
  | 'not_found'
  | 'ambiguous_id'
  | 'state_corrupt'
  | 'cli_error';

export class CompanionError extends Error {
  constructor(readonly code: CompanionErrorCode, message: string, readonly field?: string, readonly allowed?: readonly string[]) {
    super(message);
    this.name = 'CompanionError';
  }
}

export function missingField(field: string): never {
  throw new CompanionError('missing_field', `${field} is required`, field);
}

export function invalidValue(message: string, field?: string, allowed?: readonly string[]): never {
  throw new CompanionError('invalid_value', message, field, allowed);
}

/**
 * A field this endpoint does not recognize must be rejected, not silently dropped. A caller
 * who sends a misplaced/misspelled field (e.g. a `trigger` object meant for a different
 * endpoint) otherwise gets a 2xx and a persisted record that quietly means something else
 * entirely than what they asked for -- there is no red flag anywhere in that path.
 */
export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) invalidValue(`unrecognized field(s): ${unknown.join(', ')}`, unknown[0], allowed);
}
