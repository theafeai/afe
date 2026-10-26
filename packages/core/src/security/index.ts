// Security baseline (AFE-5). See docs/security/.
export { Secret, REDACTED, revealIfSecret } from "./secret.ts";
export {
  type KeyProvider,
  type EncryptionContext,
  type EnvKeyProviderOptions,
  EnvKeyProvider,
  DEFAULT_KEY_ID,
  parseKeyList,
  generateEncryptionKey,
} from "./keys.ts";
export {
  type EncryptedSecret,
  type SecretBinding,
  encryptSecret,
  decryptSecret,
  encryptionContext,
  serializeContext,
  DecryptionError,
  UnknownKeyError,
} from "./crypto.ts";
export {
  type HmacAlgorithm,
  type VerifyHmacOptions,
  type DeliveryRecord,
  type ReplayGuard,
  verifyHmacSignature,
  verifyGitHubSignature,
  verifyVercelSignature,
  signHmac,
  isTimestampFresh,
  InMemoryReplayGuard,
} from "./webhook.ts";
export {
  SENSITIVE_HEADERS,
  SENSITIVE_KEYS,
  LOG_REDACT_PATHS,
  LOG_REDACT_OPTIONS,
  isSensitiveKey,
  redactDeep,
  redactHeaders,
} from "./redaction.ts";
export {
  type OutboundUrlPolicy,
  type AddressClass,
  UnsafeUrlError,
  classifyAddress,
  validateOutboundUrl,
  createSafeLookup,
} from "./outbound-url.ts";
