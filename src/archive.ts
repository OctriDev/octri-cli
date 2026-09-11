/**
 * Archive extraction for downloaded SDK artifacts.
 *
 * Hand-rolled tar + zip readers so that inspecting generated output needs no
 * extra dependency and no `tar`/`unzip` binary on the host. Both readers refuse
 * to write outside the destination directory (zip-slip), because the archive is
 * produced by a remote service. Both are bounded too, since a few kilobytes of
 * deflate stream can expand to gigabytes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

export interface ExtractedFile {
  path: string;
  size: number;
}

/** Ceilings on what one artifact may expand to. */
export interface ExtractLimits {
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
};

function assertWithinBudget(
  total: number,
  entries: number,
  limits: ExtractLimits,
): void {
  if (total > limits.maxTotalBytes) {
    throw new Error(
      `Archive expands beyond ${limits.maxTotalBytes} bytes. Refusing to extract it.`,
    );
  }
  if (entries > limits.maxEntries) {
    throw new Error(
      `Archive holds more than ${limits.maxEntries} entries. Refusing to extract it.`,
    );
  }
}

// ─── Path safety ──────────────────────────────────────────────────────────────

/** Returns a destination-relative path, or null when the entry escapes it. */
function safePath(entry: string): string | null {
  const cleaned = normalize(entry).replace(/^([/\\])+/, "");
  if (cleaned === "" || cleaned === ".") return null;
  if (cleaned.split(/[/\\]/).includes("..")) return null;
  return cleaned;
}

// ─── tar / tar.gz ─────────────────────────────────────────────────────────────

const TAR_BLOCK = 512;

/**
 * Minimal USTAR reader: regular files and directories, with GNU long-name
 * (`L`) entries honoured. Anything else in the stream is skipped.
 */
export function extractTar(
  buffer: Buffer,
  destination: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractedFile[] {
  const written: ExtractedFile[] = [];
  let offset = 0;
  let totalBytes = 0;
  let pendingLongName: string | undefined;

  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((byte) => byte === 0)) break;

    const rawName = readString(header, 0, 100);
    const sizeField = readString(header, 124, 12).trim();
    const parsedSize = parseInt(sizeField.replace(/[^0-7]/g, ""), 8);
    const size = Number.isNaN(parsedSize) ? 0 : parsedSize;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);

    offset += TAR_BLOCK;
    const body = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeFlag === "L") {
      // GNU long name: the *next* header's name lives in this entry's body.
      pendingLongName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }

    const name =
      pendingLongName ?? (prefix === "" ? rawName : `${prefix}/${rawName}`);
    pendingLongName = undefined;

    const relative = safePath(name);
    if (relative === null) continue;

    if (typeFlag === "5" || name.endsWith("/")) {
      mkdirSync(join(destination, relative), { recursive: true });
      continue;
    }
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "") continue;

    totalBytes += body.length;
    assertWithinBudget(totalBytes, written.length + 1, limits);

    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    written.push({ path: relative.split(sep).join("/"), size });
  }

  return written;
}

export function extractTarGz(
  buffer: Buffer,
  destination: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractedFile[] {
  let unpacked: Buffer;
  try {
    unpacked = gunzipSync(buffer, { maxOutputLength: limits.maxTotalBytes });
  } catch {
    throw new Error(
      `Archive expands beyond ${limits.maxTotalBytes} bytes. Refusing to extract it.`,
    );
  }
  return extractTar(unpacked, destination, limits);
}

function readString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

// ─── zip ──────────────────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Reads the central directory (not the local headers) so that entries with
 * streamed sizes, the common case for generated archives, still extract.
 * Supports stored (0) and deflate (8) only, which is everything a generator
 * produces.
 */
export function extractZip(
  buffer: Buffer,
  destination: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractedFile[] {
  const eocd = findEocd(buffer);
  if (eocd === -1)
    throw new Error("Not a zip archive (no end-of-directory record).");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const written: ExtractedFile[] = [];
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) break;

    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer
      .subarray(pointer + 46, pointer + 46 + nameLength)
      .toString("utf8");

    pointer += 46 + nameLength + extraLength + commentLength;

    const relative = safePath(name);
    if (relative === null) continue;

    if (name.endsWith("/")) {
      mkdirSync(join(destination, relative), { recursive: true });
      continue;
    }

    // Local header: name/extra lengths differ from the central copy.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (method === 0) {
      content = raw;
    } else if (method === 8) {
      // Header sizes come from the archive, so the budget is the real bound.
      content = inflate(raw, Math.max(1, limits.maxTotalBytes - totalBytes));
    } else {
      continue;
    }

    totalBytes += content.length;
    assertWithinBudget(totalBytes, written.length + 1, limits);

    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push({
      path: relative.split(sep).join("/"),
      size: uncompressedSize === 0 ? content.length : uncompressedSize,
    });
  }

  return written;
}

/** Inflates with a hard ceiling, reporting zlib's own limit error as a refusal. */
function inflate(raw: Buffer, maxOutputLength: number): Buffer {
  try {
    return inflateRawSync(raw, { maxOutputLength });
  } catch {
    throw new Error(
      `Archive expands beyond ${maxOutputLength} bytes. Refusing to extract it.`,
    );
  }
}

function findEocd(buffer: Buffer): number {
  // The record is at the very end unless there is a zip comment; scan back over
  // the maximum comment length (64 KiB) rather than assuming.
  const start = Math.max(0, buffer.length - 0x10000 - 22);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/** Picks a reader from the magic bytes, falling back to the filename. */
export function extract(
  buffer: Buffer,
  destination: string,
  filename = "",
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractedFile[] {
  mkdirSync(destination, { recursive: true });

  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;

  if (isGzip) return extractTarGz(buffer, destination, limits);
  if (isZip) return extractZip(buffer, destination, limits);
  if (filename.endsWith(".tar")) return extractTar(buffer, destination, limits);

  throw new Error(
    `Unrecognised archive format for ${filename === "" ? "artifact" : filename}: expected .tgz or .zip.`,
  );
}

/** Returns an archive label that cannot disclose a presigned URL credential. */
export function safeArtifactFilename(url: string): string {
  const pathname = new URL(url).pathname;
  const filename = pathname.slice(pathname.lastIndexOf("/") + 1);
  return filename === "" ? "artifact" : filename;
}
