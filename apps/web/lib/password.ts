/**
 * Password hashing per 13_SECURITY_SPECIFICATION.md §2.2.
 * argon2id preferred — memory-hard, resistant to GPU cracking.
 */
import argon2 from "argon2";

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash or verification error — fail closed, never throw
    // an ambiguous state up to the caller (05 §159).
    return false;
  }
}
