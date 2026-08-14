const maxTimestamp = 0xffff_ffff_ffff;

export type UuidV7GeneratorOptions = {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
};

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  let lastTimestamp = -1;
  let sequence = 0;

  return () => {
    const currentTimestamp = Math.floor(now());
    if (currentTimestamp < 0 || currentTimestamp > maxTimestamp) throw new RangeError("UUIDv7 timestamp is outside its 48-bit range.");
    if (currentTimestamp > lastTimestamp) {
      lastTimestamp = currentTimestamp;
      const random = randomBytes(2);
      sequence = (((random[0] ?? 0) << 4) | ((random[1] ?? 0) >>> 4)) & 0x0fff;
    } else {
      sequence += 1;
      if (sequence > 0x0fff) {
        if (lastTimestamp === maxTimestamp) throw new RangeError("UUIDv7 sequence overflow at the final representable millisecond.");
        lastTimestamp += 1;
        sequence = 0;
      }
    }
    const bytes = randomBytes(16);
    let timestamp = lastTimestamp;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = timestamp & 0xff;
      timestamp = Math.floor(timestamp / 256);
    }
    bytes[6] = 0x70 | (sequence >>> 8);
    bytes[7] = sequence & 0xff;
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    return formatUuid(bytes);
  };
}

export const createUuidV7 = createUuidV7Generator();
