import type { CanonicalEvent } from "./api/types.ts";

export function credentialOwnerLabel(event: CanonicalEvent): string | null {
  const owner = event.data?.credentialOwner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  for (const key of ["login", "name", "id"]) {
    const value = owner[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}
