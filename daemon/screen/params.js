const TOKEN = /^[0-9a-f]{64}$/;
const PASSWORD = /^[0-9a-f]{8}$/;
const PORT = /^[0-9]{4,5}$/;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const KEYS = ["port", "token", "password"];
export const READY_MESSAGE = "hive-screen-ready";

function validated(port, token, password) {
  if (typeof port !== "string" || typeof token !== "string" || typeof password !== "string") return null;
  if (!PORT.test(port) || !TOKEN.test(token) || !PASSWORD.test(password)) return null;
  const number = Number(port);
  if (number < MIN_PORT || number > MAX_PORT) return null;
  return { port: number, token, password };
}

export function screenParams(hash) {
  const fields = new Map();
  for (const part of String(hash).replace(/^#/, "").split("&")) {
    const split = part.indexOf("=");
    if (split <= 0) continue;
    const key = part.slice(0, split);
    if (!KEYS.includes(key)) continue;
    if (fields.has(key)) return null;
    fields.set(key, part.slice(split + 1));
  }
  return validated(fields.get("port") ?? "", fields.get("token") ?? "", fields.get("password") ?? "");
}

export function screenParamsFrom(message) {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const { port, token, password } = message;
  return validated(Number.isInteger(port) ? String(port) : null, token, password);
}

export function socketUrl(params) {
  return `ws://127.0.0.1:${params.port}/websockify?token=${params.token}`;
}

export function openerMessage(event, origin, opener) {
  if (!opener || event.origin !== origin || event.source !== opener) return { kind: "ignore" };
  const params = screenParamsFrom(event.data);
  return params ? { kind: "secrets", params } : { kind: "invalid" };
}
