import { createHash, getRandomValues } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Clock, Compressor, Hasher } from '@suture/core';
import { FAST_CHECK_VERSION, SUTURE_VERSION } from '../bridge/versions.ts';

/** Node implementations of the core host ports (Spec 03 design §2: `node:crypto` and `node:zlib`). */
export const nodeHasher: Hasher = {
  sha256: (bytes) => Promise.resolve(new Uint8Array(createHash('sha256').update(bytes).digest())),
};

export const nodeCompressor: Compressor = {
  deflateRaw: (bytes) => Promise.resolve(new Uint8Array(deflateRawSync(bytes))),
  inflateRaw: (bytes) => Promise.resolve(new Uint8Array(inflateRawSync(bytes))),
};

export const nodeClock: Clock = { now: () => performance.timeOrigin + performance.now() };

export const NODE_VERSIONS = { suture: SUTURE_VERSION, fastCheck: FAST_CHECK_VERSION } as const;

/** A fresh 32-bit Exorcist seed from the OS CSPRNG (same distribution as the web host's `randomSeed`). */
export function randomSeed(): number {
  return getRandomValues(new Int32Array(1))[0] ?? 1;
}
