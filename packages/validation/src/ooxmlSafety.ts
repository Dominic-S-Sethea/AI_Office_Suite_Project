import { createHash } from "node:crypto";
import { Unzip, UnzipInflate, UnzipPassThrough, unzipSync, zipSync } from "fflate";

export type OoxmlFormatKind = "docx" | "xlsx" | "pptx";

export interface OoxmlSafetyPolicy {
  format: OoxmlFormatKind;
  maxUploadBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  allowedExtensions: readonly string[];
  blockedMacroExtensions: readonly string[];
  repackCleanZip?: boolean;
}

export const OOXML_POLICIES: Record<OoxmlFormatKind, OoxmlSafetyPolicy> = {
  docx: {
    format: "docx",
    maxUploadBytes: 10 * 1024 * 1024,
    maxEntries: 500,
    maxEntryBytes: 25 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxCompressionRatio: 100,
    allowedExtensions: [".docx"],
    blockedMacroExtensions: [".docm", ".dotm"],
    repackCleanZip: true,
  },
  xlsx: {
    format: "xlsx",
    maxUploadBytes: 20 * 1024 * 1024,
    maxEntries: 600,
    maxEntryBytes: 25 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxCompressionRatio: 100,
    allowedExtensions: [".xlsx"],
    blockedMacroExtensions: [".xlsm", ".xlsb"],
    repackCleanZip: true,
  },
  pptx: {
    format: "pptx",
    maxUploadBytes: 15 * 1024 * 1024,
    maxEntries: 600,
    maxEntryBytes: 35 * 1024 * 1024,
    maxTotalBytes: 100 * 1024 * 1024,
    maxCompressionRatio: 100,
    allowedExtensions: [".pptx"],
    blockedMacroExtensions: [".pptm", ".potm", ".ppsm"],
    repackCleanZip: false,
  },
};

export type OoxmlInspectResult =
  | {
      ok: true;
      originalSha256: string;
      entries: Record<string, Uint8Array>;
      repackedBuffer: Uint8Array;
      totalUncompressedBytes: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

class InternalOoxmlAbort extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function validateZipEntryName(
  entryName: string,
  format: OoxmlFormatKind,
  label: string,
  seenNormalized: Set<string>,
): void {
  if (
    entryName.includes("..") ||
    entryName.startsWith("/") ||
    entryName.startsWith("\\") ||
    /^[A-Za-z]:/.test(entryName) ||
    entryName.includes("\0")
  ) {
    throw new InternalOoxmlAbort(
      "ZIP_PATH_TRAVERSAL_BLOCKED",
      `${label} archive contains unsafe path-traversal entries.`,
    );
  }
  const normalizedName = entryName.replace(/\\/g, "/").toLowerCase();
  if (seenNormalized.has(normalizedName)) {
    throw new InternalOoxmlAbort(
      "DUPLICATE_ARCHIVE_ENTRY",
      `${label} archive contains duplicate entry '${entryName}' (ZIP parser differential blocked).`,
    );
  }
  seenNormalized.add(normalizedName);

  if (/EncryptedPackage/i.test(entryName)) {
    throw new InternalOoxmlAbort(
      format === "xlsx" ? "ENCRYPTED_WORKBOOK_UNSUPPORTED" : "ENCRYPTED_FILE_UNSUPPORTED",
      `Encrypted ${label} files are not supported.`,
    );
  }
  if (/vbaProject\.bin|vbaData\.xml|\.xlm$/i.test(entryName)) {
    throw new InternalOoxmlAbort(
      format === "xlsx" ? "MACRO_WORKBOOK_BLOCKED" : "MACRO_CONTENT_BLOCKED",
      `Embedded macro part '${entryName}' detected and blocked.`,
    );
  }
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Single-source hardened OOXML ZIP preflight & streaming extractor (H1, M2):
 * 1. Blocks macro extensions, OLE2 encrypted containers, and non-ZIP magic bytes.
 * 2. Central Directory preflight (0 bytes inflated): checks entry count, traversal, duplicate
 *    normalized names, encrypted/macro entries, and declared size/ratio bounds.
 * 3. Chunked (1 KB compressed slices) streaming `Unzip` extraction: checks Local File Header
 *    names match Central Directory (defeating ZIP parser differentials) and enforces actual
 *    decompressed byte limits & real compression ratios MID-STREAM before memory exhaustion
 *    (defeating forged Central Directory `originalSize` ZIP bombs).
 * 4. Re-packs verified entries into a clean canonical ZIP so downstream parsers (`mammoth`,
 *    `ExcelJS`) never re-parse untrusted raw ZIP structures.
 */
export function validateOoxmlUploadHeader(
  filename: string,
  buffer: Uint8Array,
  format: OoxmlFormatKind,
): { ok: true } | { ok: false; code: string; message: string } {
  const policy = OOXML_POLICIES[format];
  const label = format.toUpperCase();

  if (buffer.byteLength === 0) {
    return { ok: false, code: "EMPTY_UPLOAD", message: `Uploaded ${label} file is empty.` };
  }
  if (buffer.byteLength > policy.maxUploadBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `Uploaded ${label} exceeds maximum limit (${policy.maxUploadBytes} bytes).`,
    };
  }

  const lower = filename.toLowerCase();
  if (policy.blockedMacroExtensions.some((ext) => lower.endsWith(ext))) {
    const macroCode =
      format === "xlsx"
        ? "MACRO_WORKBOOK_BLOCKED"
        : format === "pptx"
          ? "MACRO_PRESENTATION_BLOCKED"
          : "MACRO_FILE_BLOCKED";
    return {
      ok: false,
      code: macroCode,
      message: `Macro-enabled ${label} format '${filename}' is blocked for security.`,
    };
  }
  if (!policy.allowedExtensions.some((ext) => lower.endsWith(ext))) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTENSION",
      message: `Only ${policy.allowedExtensions.join(", ")} files are accepted by the ${label} importer.`,
    };
  }

  // OLE2 Compound File Binary magic bytes (D0 CF 11 E0 A1 B1 1A E1) — encrypted or legacy binary Office
  if (
    buffer.byteLength >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return {
      ok: false,
      code: format === "xlsx" ? "ENCRYPTED_WORKBOOK_UNSUPPORTED" : "ENCRYPTED_FILE_UNSUPPORTED",
      message: `Encrypted or legacy OLE2 binary ${label} files are not supported.`,
    };
  }

  // ZIP Local File Header magic PK\x03\x04
  if (
    buffer.byteLength < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return {
      ok: false,
      code: format === "xlsx" ? "INVALID_XLSX_ZIP" : "INVALID_ZIP_MAGIC",
      message: `Uploaded ${label} is not a valid OOXML ZIP container.`,
    };
  }

  return { ok: true };
}

export function inspectAndExtractOoxmlZip(
  buffer: Uint8Array,
  filename: string,
  format: OoxmlFormatKind,
): OoxmlInspectResult {
  const headerCheck = validateOoxmlUploadHeader(filename, buffer, format);
  if (!headerCheck.ok) {
    return headerCheck;
  }

  const policy = OOXML_POLICIES[format];
  const label = format.toUpperCase();
  const originalSha256 = createHash("sha256").update(buffer).digest("hex");

  // Stage 1: Zero-decompression Central Directory metadata & duplicate-entry scan
  let cdEntryCount = 0;
  let declaredTotalBytes = 0;
  const cdNormalizedNames = new Set<string>();
  const cdCompressedSizes = new Map<string, number>();

  try {
    unzipSync(buffer, {
      filter: (f) => {
        cdEntryCount++;
        if (cdEntryCount > policy.maxEntries) {
          throw new InternalOoxmlAbort("TOO_MANY_ARCHIVE_ENTRIES", `${label} exceeds archive entry safety limit.`);
        }
        validateZipEntryName(f.name, format, label, cdNormalizedNames);

        declaredTotalBytes += f.originalSize;
        if (
          f.originalSize > policy.maxEntryBytes ||
          declaredTotalBytes > policy.maxTotalBytes ||
          (f.originalSize > 1_048_576 && f.size > 0 && f.originalSize / f.size > policy.maxCompressionRatio)
        ) {
          throw new InternalOoxmlAbort(
            "ZIP_BOMB_BLOCKED",
            `${label} archive exceeds safe decompressed size or compression ratio bounds.`,
          );
        }
        cdCompressedSizes.set(f.name.replace(/\\/g, "/").toLowerCase(), f.size);
        return false; // inspect metadata only; real decompression runs bounded in Stage 2
      },
    });
  } catch (err) {
    if (err instanceof InternalOoxmlAbort) {
      return { ok: false, code: err.code, message: err.message };
    }
    const malformedCode =
      format === "xlsx"
        ? "INVALID_XLSX_ZIP"
        : format === "pptx"
          ? "MALFORMED_PPTX_ARCHIVE"
          : "MALFORMED_DOCX_ARCHIVE";
    return { ok: false, code: malformedCode, message: `Unable to unpack OOXML ${label} archive safely.` };
  }

  // Stage 2: Chunked streaming Unzip with mid-stream actual byte enforcement
  const entries: Record<string, Uint8Array> = {};
  const lfhNormalizedNames = new Set<string>();
  let lfhEntryCount = 0;
  let actualTotalBytes = 0;

  try {
    const unzipper = new Unzip();
    unzipper.register(UnzipPassThrough);
    unzipper.register(UnzipInflate);

    unzipper.onfile = (file) => {
      lfhEntryCount++;
      if (lfhEntryCount > policy.maxEntries) {
        throw new InternalOoxmlAbort("TOO_MANY_ARCHIVE_ENTRIES", `${label} exceeds archive entry safety limit.`);
      }
      validateZipEntryName(file.name, format, label, lfhNormalizedNames);

      const normalizedName = file.name.replace(/\\/g, "/").toLowerCase();
      if (!cdNormalizedNames.has(normalizedName)) {
        throw new InternalOoxmlAbort(
          "DUPLICATE_ARCHIVE_ENTRY",
          `${label} archive local file header '${file.name}' mismatches central directory (ZIP parser differential blocked).`,
        );
      }

      const chunks: Uint8Array[] = [];
      let entryActualBytes = 0;
      const compLen = file.size ?? cdCompressedSizes.get(normalizedName) ?? 0;

      file.ondata = (err, chunk, final) => {
        if (err) {
          throw err;
        }
        if (chunk && chunk.byteLength > 0) {
          entryActualBytes += chunk.byteLength;
          actualTotalBytes += chunk.byteLength;
          if (
            entryActualBytes > policy.maxEntryBytes ||
            actualTotalBytes > policy.maxTotalBytes ||
            (entryActualBytes > 1_048_576 && compLen > 0 && entryActualBytes / compLen > policy.maxCompressionRatio) ||
            (actualTotalBytes > 1_048_576 && buffer.byteLength > 0 && actualTotalBytes / buffer.byteLength > policy.maxCompressionRatio)
          ) {
            throw new InternalOoxmlAbort(
              "ZIP_BOMB_BLOCKED",
              `${label} archive actual decompressed bytes exceeded safe size or compression ratio bounds.`,
            );
          }
          chunks.push(chunk);
        }
        if (final) {
          entries[file.name] = concatChunks(chunks, entryActualBytes);
        }
      };

      file.start();
    };

    // Push in small compressed slices (1 KB) so deflate bombs abort mid-stream before full allocation
    const CHUNK_STEP = 1024;
    for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_STEP) {
      const end = Math.min(offset + CHUNK_STEP, buffer.byteLength);
      unzipper.push(buffer.subarray(offset, end), end >= buffer.byteLength);
    }

    if (lfhEntryCount !== cdEntryCount) {
      throw new InternalOoxmlAbort(
        "DUPLICATE_ARCHIVE_ENTRY",
        `${label} archive entry count mismatch between local headers (${lfhEntryCount}) and central directory (${cdEntryCount}).`,
      );
    }
  } catch (err) {
    if (err instanceof InternalOoxmlAbort) {
      return { ok: false, code: err.code, message: err.message };
    }
    const malformedCode =
      format === "xlsx"
        ? "INVALID_XLSX_ZIP"
        : format === "pptx"
          ? "MALFORMED_PPTX_ARCHIVE"
          : "MALFORMED_DOCX_ARCHIVE";
    return { ok: false, code: malformedCode, message: `Unable to unpack OOXML ${label} archive safely.` };
  }

  const repackedBuffer = policy.repackCleanZip ? zipSync(entries, { level: 0 }) : buffer;

  return {
    ok: true,
    originalSha256,
    entries,
    repackedBuffer,
    totalUncompressedBytes: actualTotalBytes,
  };
}

const OWASP_CSV_FORMULA_PREFIX = /^[\s\x00-\x1f]*[=+\-@]|^[\t\r]/;

/**
 * Shared OWASP CSV formula-injection neutralization (M2):
 * Preserves finite numbers (including negative numbers like -0.05) and booleans verbatim,
 * while prefixing untrusted strings starting with =, +, -, @, tab, or CR with a single quote.
 */
export function escapeSafeCsvCell(rawVal: unknown): { cell: string; neutralized: boolean } {
  if (rawVal === null || rawVal === undefined) {
    return { cell: "", neutralized: false };
  }
  if (typeof rawVal === "number") {
    return { cell: Number.isFinite(rawVal) ? String(rawVal) : "", neutralized: false };
  }
  if (typeof rawVal === "boolean") {
    return { cell: String(rawVal), neutralized: false };
  }
  let text = String(rawVal);
  let neutralized = false;
  if (OWASP_CSV_FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
    neutralized = true;
  }
  if (text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return { cell: text, neutralized };
}
