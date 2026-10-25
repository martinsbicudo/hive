import { createHmac } from "node:crypto";
import { HttpError } from "./httpError.ts";
import { VERSION } from "./version.ts";

export const HEALTH_DOMAIN = "hive-health-v1:";
const NONCE = /^[0-9a-f]{32}$/;

export function healthProof(secret: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(HEALTH_DOMAIN + nonce, "utf8").digest("hex");
}

export function healthReply(params: URLSearchParams, secret: string): { ok: true; version: string; proof?: string } {
  if (!params.has("nonce")) return { ok: true, version: VERSION };
  const nonces = params.getAll("nonce");
  const nonce = nonces[0];
  if (nonces.length !== 1 || nonce === undefined || !NONCE.test(nonce)) throw new HttpError(400, "nonce must be 32 lowercase hex characters");
  return { ok: true, version: VERSION, proof: healthProof(secret, nonce) };
}
