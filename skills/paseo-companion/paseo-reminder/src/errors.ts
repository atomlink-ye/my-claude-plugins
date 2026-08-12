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
