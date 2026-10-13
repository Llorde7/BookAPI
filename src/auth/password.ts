import argon2 from 'argon2';

// Argon2id with the library defaults (64 MiB memory, 3 passes), which meet OWASP
// guidance. The parameters are stored inside each hash, so they can be raised later.
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// A real hash of a throwaway password. Checking against it when there is no usable
// hash makes "unknown email" take as long as "wrong password", so response time
// doesn't reveal which emails have accounts.
const dummyHash = hashPassword('timing-equalizer-not-a-real-password');

/** Returns false (never throws) for a wrong password, a missing hash or a malformed hash. */
export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (hash) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // Malformed hash, e.g. the seed's placeholder. Treat as a failed login.
    }
  }
  await argon2.verify(await dummyHash, password).catch(() => false);
  return false;
}
