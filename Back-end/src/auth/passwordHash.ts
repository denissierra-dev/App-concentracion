import crypto from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;

// Pre-derived dummy hash used to keep login verification timing uniform on unknown accounts.
const DUMMY_HASH =
  'scrypt$16384$8$1$00000000000000000000000000000000$' + '00'.repeat(KEY_LEN);

function deriveScrypt(
  password: string,
  saltHex: string,
  n: number,
  r: number,
  p: number,
  keyLen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFC'),
      Buffer.from(saltHex, 'hex'),
      keyLen,
      { N: n, r, p, maxmem: 32 * 1024 * 1024 },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      }
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex');
  const derived = await deriveScrypt(password, saltHex, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  const candidate = storedHash ?? DUMMY_HASH;
  const parts = candidate.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await deriveScrypt(password, '00000000000000000000000000000000', SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
    return false;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4] ?? '';
  const expectedHex = parts[5] ?? '';

  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 1024 ||
    !/^[0-9a-f]+$/i.test(saltHex) ||
    !/^[0-9a-f]+$/i.test(expectedHex)
  ) {
    return false;
  }

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const derived = await deriveScrypt(password, saltHex, n, r, p, expectedBuf.length);

  if (storedHash === null || storedHash === undefined) {
    return false;
  }
  if (derived.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(derived, expectedBuf);
}
