import type { Clock, Compressor, Hasher } from '@suture/core';

/** Web host implementations of the core ports (Spec 03 §2). */
export const webHasher: Hasher = {
  async sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  },
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes.slice().buffer]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export const webCompressor: Compressor = {
  deflateRaw: (bytes) => pipe(bytes, new CompressionStream('deflate-raw')),
  inflateRaw: (bytes) => pipe(bytes, new DecompressionStream('deflate-raw')),
};

export const webClock: Clock = { now: () => performance.timeOrigin + performance.now() };

/** Yields on a fresh MessageChannel tick (Spec 01 Req 10.7 / Spec 04 §1). */
export function yieldControl(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Int32Array(1))[0] ?? 1;
}
