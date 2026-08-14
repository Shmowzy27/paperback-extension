import { HOSTNAME, type ReaderEntry } from "./models";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Hand-rolled because the payload is binary. `Application.base64Decode` returns
 * either a string or an ArrayBuffer depending on whether the bytes happen to be
 * valid UTF-8, and we need the raw bytes unconditionally.
 */
function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);

  let accumulator = 0;
  let bits = 0;
  let out = 0;

  for (let i = 0; i < clean.length; i++) {
    accumulator = (accumulator << 6) | B64_ALPHABET.indexOf(clean[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (accumulator >> bits) & 0xff;
    }
  }

  return bytes.subarray(0, out);
}

/** The first 16 primes, sieved exactly the way the site's reader does it. */
function firstPrimes(): number[] {
  const composite: boolean[] = [];
  const primes: number[] = [];

  for (let n = 2; primes.length < 16; n++) {
    if (composite[n]) continue;
    primes.push(n);
    for (let multiple = n << 1; multiple <= 256; multiple += n) {
      composite[multiple] = true;
    }
  }

  return primes;
}

/**
 * Decodes the blob handed to `initReader` on /read/{id}.
 *
 * Layout: the first 64 bytes are a key, whose leading `hostname.length` bytes
 * are XORed with the hostname the page was served from — which is what binds
 * the payload to the domain. A CRC over that key picks one of the first 16
 * primes, and that prime becomes the stride of an RC4 variant which decrypts
 * everything past byte 64 into JSON.
 */
export function decodeReaderPayload(payload: string, hostname: string = HOSTNAME): ReaderEntry[] {
  const data = base64ToBytes(payload);
  if (data.length <= 64) {
    throw new Error("Reader payload is too short to contain a key and body.");
  }

  const keyLength = Math.min(hostname.length, 64);
  for (let i = 0; i < keyLength; i++) {
    data[i] = data[i]! ^ hostname.charCodeAt(i);
  }

  let crc = 0;
  for (let i = 0; i < 64; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xc : crc >>> 1;
    }
  }
  const stride = firstPrimes()[crc & 7]!;

  // Key-scheduling over the 64-byte key.
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i++) state[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + data[i % 64]!) % 256;
    const swap = state[i]!;
    state[i] = state[j]!;
    state[j] = swap;
  }

  let i = 0;
  let carry = 0;
  let keyByte = 0;
  j = 0;

  const decoded: string[] = [];
  for (let n = 0; n + 64 < data.length; n++) {
    i = (i + stride) % 256;
    j = (carry + state[(j + state[i]!) % 256]!) % 256;
    carry = (carry + i + state[i]!) % 256;

    const swap = state[i]!;
    state[i] = state[j]!;
    state[j] = swap;

    keyByte = state[(j + state[(i + state[(keyByte + carry) % 256]!) % 256]!) % 256]!;
    decoded.push(String.fromCharCode(data[n + 64]! ^ keyByte));
  }

  return JSON.parse(decoded.join("")) as ReaderEntry[];
}
