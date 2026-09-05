import { BadRequestError } from '../http/errors.ts';

/** `on` / `off` / `toggle` (relative to `current`); anything else is a 400. */
export function parseToggle(value: string | undefined, current: boolean, name: string): boolean {
  switch (value) {
    case 'on':
      return true;
    case 'off':
      return false;
    case 'toggle':
      return !current;
    default:
      throw new BadRequestError(`${name} expects on, off or toggle, got '${value ?? ''}'`);
  }
}

export interface IntegerRange {
  min?: number;
  max?: number;
}

/** A whole number within an optional range; anything else is a 400. */
export function parseInteger(
  value: string | undefined,
  name: string,
  range: IntegerRange = {},
): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new BadRequestError(`${name} must be a whole number, got '${value ?? ''}'`);
  }

  const parsed = Number.parseInt(value, 10);
  if (
    (range.min !== undefined && parsed < range.min) ||
    (range.max !== undefined && parsed > range.max)
  ) {
    const bounds = [
      range.min !== undefined ? `at least ${range.min}` : '',
      range.max !== undefined ? `at most ${range.max}` : '',
    ]
      .filter((part) => part.length > 0)
      .join(' and ');
    throw new BadRequestError(`${name} must be ${bounds}, got ${parsed}`);
  }

  return parsed;
}

/** A required non-empty value; anything else is a 400. */
export function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}
