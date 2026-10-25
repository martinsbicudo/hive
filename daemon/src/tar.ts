const BLOCK = 512;
const META_LIMIT = 64 * 1024;
const NAME = { start: 0, length: 100 };
const SIZE = { start: 124, length: 12 };
const CHECKSUM = { start: 148, length: 8 };
const TYPE = 156;
const MAGIC = { start: 257, length: 8 };
const PREFIX = { start: 345, length: 155 };
const POSIX_MAGIC = "ustar\u000000";

export class TarError extends Error {}

export class TarTooLargeError extends TarError {}

export interface TarFile {
  name: string;
  data: Buffer;
}

interface Pending {
  path?: string;
  size?: number;
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function numeric(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  const first = field[0] ?? 0;
  if (first & 0x80) {
    if (first !== 0x80) throw new TarError("negative or oversized base-256 number");
    let value = 0;
    for (const byte of field.subarray(1)) {
      value = value * 256 + byte;
      if (!Number.isSafeInteger(value)) throw new TarError("base-256 number too large");
    }
    return value;
  }
  const digits = field.toString("latin1").replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!/^[0-7]+$/.test(digits)) throw new TarError("malformed octal number");
  const value = parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) throw new TarError("octal number too large");
  return value;
}

function checksumMatches(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= CHECKSUM.start && index < CHECKSUM.start + CHECKSUM.length ? 0x20 : (block[index] ?? 0);
  return numeric(block, CHECKSUM.start, CHECKSUM.length) === sum;
}

function paxRecords(data: Buffer): Pending {
  const pending: Pending = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const lengthText = space < 0 ? "" : data.subarray(offset, space).toString("latin1");
    if (!/^[1-9][0-9]{0,6}$/.test(lengthText)) throw new TarError("malformed pax record");
    const end = offset + Number(lengthText);
    if (end > data.length || data[end - 1] !== 0x0a) throw new TarError("malformed pax record");
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new TarError("malformed pax record");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") pending.path = value;
    if (key === "size") {
      if (!/^[0-9]{1,15}$/.test(value)) throw new TarError("malformed pax size");
      pending.size = Number(value);
    }
    offset = end;
  }
  return pending;
}

function isZero(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

export function singleFileFromTar(archive: Buffer, maxFileBytes: number): TarFile {
  let offset = 0;
  let pending: Pending = {};
  let found: TarFile | null = null;
  while (true) {
    if (offset + BLOCK > archive.length) throw new TarError("truncated archive");
    const header = archive.subarray(offset, offset + BLOCK);
    if (isZero(header)) break;
    if (!checksumMatches(header)) throw new TarError("bad header checksum");
    if (!text(header, MAGIC.start, MAGIC.length).startsWith("ustar")) throw new TarError("not a ustar archive");
    const type = String.fromCharCode(header[TYPE] ?? 0);
    const regular = type === "0" || type === "\0";
    const size = regular ? (pending.size ?? numeric(header, SIZE.start, SIZE.length)) : numeric(header, SIZE.start, SIZE.length);
    if (regular && size > maxFileBytes) throw new TarTooLargeError("file exceeds the size limit");
    const dataStart = offset + BLOCK;
    const next = dataStart + padded(size);
    if (next > archive.length) throw new TarError("truncated archive");
    const data = archive.subarray(dataStart, dataStart + size);
    offset = next;
    if (type === "x" || type === "L") {
      if (size > META_LIMIT) throw new TarError("metadata entry too large");
      if (type === "x") pending = { ...pending, ...paxRecords(data) };
      else pending.path ??= text(data, 0, data.length);
      continue;
    }
    if (!regular) throw new TarError(`unsupported entry type ${JSON.stringify(type)}`);
    if (found) throw new TarError("more than one file in the archive");
    const prefix = header.subarray(MAGIC.start, MAGIC.start + MAGIC.length).toString("latin1") === POSIX_MAGIC ? text(header, PREFIX.start, PREFIX.length) : "";
    const name = pending.path ?? (prefix ? `${prefix}/${text(header, NAME.start, NAME.length)}` : text(header, NAME.start, NAME.length));
    found = { name, data };
    pending = {};
  }
  if (pending.path !== undefined || pending.size !== undefined) throw new TarError("metadata without an entry");
  if (!found) throw new TarError("no file in the archive");
  return found;
}
