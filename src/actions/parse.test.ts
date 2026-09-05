import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { parseInteger, parseToggle, requireValue } from './parse.ts';

describe('parseToggle', () => {
  it('maps on/off/toggle and rejects anything else', () => {
    assert.equal(parseToggle('on', false, 'x'), true);
    assert.equal(parseToggle('off', true, 'x'), false);
    assert.equal(parseToggle('toggle', true, 'x'), false);
    assert.equal(parseToggle('toggle', false, 'x'), true);
    assert.throws(
      () => parseToggle('maybe', false, 'nightmode'),
      (e: unknown) => e instanceof BadRequestError && /nightmode expects/.test(e.message),
    );
    assert.throws(() => parseToggle(undefined, false, 'x'), BadRequestError);
  });
});

describe('parseInteger', () => {
  it('parses whole numbers within the range', () => {
    assert.equal(parseInteger('42', 'seconds'), 42);
    assert.equal(parseInteger('-5', 'bass', { min: -10, max: 10 }), -5);
    assert.throws(() => parseInteger('4.2', 'seconds'), /whole number/);
    assert.throws(() => parseInteger(undefined, 'seconds'), /whole number/);
    assert.throws(
      () => parseInteger('11', 'bass', { min: -10, max: 10 }),
      /at least -10 and at most 10, got 11/,
    );
    assert.throws(() => parseInteger('0', 'track', { min: 1 }), /at least 1/);
  });
});

describe('requireValue', () => {
  it('rejects empty values', () => {
    assert.equal(requireValue('x', 'name'), 'x');
    assert.throws(() => requireValue('', 'name'), /name is required/);
    assert.throws(() => requireValue(undefined, 'name'), BadRequestError);
  });
});
