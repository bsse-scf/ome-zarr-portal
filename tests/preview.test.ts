import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  axisRoles,
  bytesPerElement,
  isPreviewable,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_EXTENT,
  previewInputBytes,
} from '../src/preview/policy';

describe('preview axis roles', () => {
  it('reads declared axis names, whatever their order', () => {
    assert.deepEqual(axisRoles(['t', 'c', 'z', 'y', 'x'], 5), { t: 0, c: 1, y: 3, x: 4 });
    assert.deepEqual(axisRoles(['y', 'x', 'c'], 3), { y: 0, x: 1, t: undefined, c: 2 });
  });

  it('is case-insensitive, as images in the wild are inconsistent', () => {
    assert.deepEqual(axisRoles(['C', 'Y', 'X'], 3), { y: 1, x: 2, t: undefined, c: 0 });
  });

  it('assumes tczyx for a rank-5 array that declares no axes', () => {
    // The pre-0.4 spec fixed the layout, so this is not a guess.
    assert.deepEqual(axisRoles(undefined, 5), { t: 0, c: 1, y: 3, x: 4 });
  });

  it('falls back to the last two dimensions when axes are unknown', () => {
    assert.deepEqual(axisRoles(undefined, 3), { y: 1, x: 2 });
    assert.deepEqual(axisRoles(['y', 'x'], 3), { y: 1, x: 2 });
  });
});

describe('dtype widths', () => {
  it('understands both Zarr spellings', () => {
    assert.equal(bytesPerElement('uint16'), 2);
    assert.equal(bytesPerElement('<u2'), 2);
    assert.equal(bytesPerElement('float32'), 4);
    assert.equal(bytesPerElement('>f8'), 8);
    assert.equal(bytesPerElement('|u1'), 1);
  });

  it('assumes the widest plausible element for anything unrecognised', () => {
    // Gating an unknown format optimistically would be the expensive mistake.
    assert.equal(bytesPerElement(undefined), 8);
    assert.equal(bytesPerElement('|S16'), 8);
  });
});

describe('preview eligibility', () => {
  const roles = { t: 0, c: 1, y: 3, x: 4 };

  it('sizes the read on one timepoint, not the whole series', () => {
    const shape = [1000, 2, 4, 256, 256];
    assert.equal(previewInputBytes(shape, roles, 'uint16'), 2 * 4 * 256 * 256 * 2);
    assert.equal(isPreviewable(shape, roles, 'uint16'), true);
  });

  it('counts channels and depth, which are all read', () => {
    const shape = [1, 64, 64, 256, 256];
    assert.ok(previewInputBytes(shape, roles, 'uint16') > MAX_PREVIEW_BYTES);
    assert.equal(isPreviewable(shape, roles, 'uint16'), false);
  });

  it('takes the dtype into account, not just the element count', () => {
    // Same shape, four times the bytes: one fits the budget and one does not.
    const shape = [1, 1, 4, 4096, 4096];
    assert.equal(isPreviewable(shape, roles, 'uint8'), true);
    assert.equal(isPreviewable(shape, roles, 'float32'), false);
  });

  it('rejects a degenerate shape even when it is small', () => {
    // A 1 × 1,000,000 strip is well inside the byte budget but projects to a
    // canvas no browser will allocate.
    const wide = [1, 1, 1, 1, MAX_PREVIEW_EXTENT + 1];
    assert.ok(previewInputBytes(wide, roles, 'uint8') < MAX_PREVIEW_BYTES);
    assert.equal(isPreviewable(wide, roles, 'uint8'), false);
  });

  it('rejects empty and sub-2D arrays', () => {
    assert.equal(isPreviewable([256], { y: 0, x: 0 }, 'uint8'), false);
    assert.equal(isPreviewable([1, 1, 0, 256, 256], roles, 'uint8'), false);
    assert.equal(isPreviewable([1, 1, 1, 0, 256], roles, 'uint8'), false);
  });
});
