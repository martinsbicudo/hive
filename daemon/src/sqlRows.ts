import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export type Row = Record<string, SQLOutputValue>;

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`column ${key} is not text`);
  return value;
}

export function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

export function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`column ${key} is not a number`);
}

export function optionalNumber(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : number(row, key);
}

export function flag(row: Row, key: string): boolean {
  return number(row, key) === 1;
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

export function columnsOf(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => text(row, "name"));
}
