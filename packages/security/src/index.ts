/**
 * @code-brothers/security — secure-by-default primitives for Code Brothers
 * (spec §8): Argon2id password hashing, TOTP 2FA, AES-256-GCM envelope
 * credential vault, secret redaction scrubber, DNS-pinning SSRF firewall,
 * brute-force login throttle, and the one-time first-boot setup token.
 */
export { hashPassword, verifyPassword } from './password.js';

export {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  hotpCode,
  totpCode,
  verifyTotp,
} from './totp.js';

export {
  VAULT_ALGORITHM,
  type EncryptedSecret,
  parseMasterKey,
  getMasterKey,
  generateMasterKey,
  encryptSecret,
  decryptSecret,
  rotateRecord,
} from './vault.js';

export { REDACTED, redact, redactString, type RedactOptions } from './redact.js';

export {
  SsrfError,
  type SsrfOptions,
  type ValidatedUrl,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  assertUrlAllowed,
} from './ssrf.js';

export {
  LoginThrottle,
  MemoryThrottleStore,
  type ThrottleEntry,
  type LoginThrottleStore,
  type LoginThrottleOptions,
  type ThrottleStatus,
} from './throttle.js';

export {
  SetupTokenService,
  MemorySetupTokenStore,
  type SetupTokenStore,
  type SetupTokenOptions,
  generateSetupToken,
  verifySetupToken,
  defaultSetupTokenService,
} from './setup-token.js';
