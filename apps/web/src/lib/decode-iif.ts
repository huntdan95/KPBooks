/**
 * Decode an uploaded QuickBooks .iif file into text.
 *
 * QBD exports are typically Windows-1252 (curly quotes, é, ñ are single
 * high bytes -- not valid UTF-8), so we try strict UTF-8 first and fall
 * back to windows-1252. A customer who opens the export in Excel and
 * re-saves it as "Unicode Text" produces UTF-16 with a BOM instead;
 * decoded as windows-1252 that becomes NUL-interleaved garbage that parses
 * to an all-zero preview with no warnings and an enabled Confirm button.
 * Sniff the UTF-16 BOMs and decode properly, and treat any surviving NULs
 * (BOM-less UTF-16) as a hard error instead of letting the silent empty
 * preview through.
 */
/**
 * Byte ceiling applied BEFORE the file is read. Carries 2x headroom over the
 * 12 MB character cap the decoded text is judged by, so a UTF-16 re-save (two
 * bytes per character) is still assessed on its content rather than its size.
 */
export const MAX_IIF_FILE_BYTES = 24_000_000;

/** QuickBooks company files, backups and their sidecars. Binary, never IIF. */
const QB_BINARY_EXTENSION = /\.(qbw|qbb|qbm|qbx|qby|qba|nd|tlg|dsn)$/i;

export type IifFileMetaProblem =
  | { kind: 'notAnIifFile' }
  | { kind: 'emptyOrFolder' }
  | { kind: 'tooLarge'; sizeMb: string };

/**
 * Judge an uploaded file by its NAME and SIZE, before a byte of it is read.
 *
 * The drop zone accepts anything the OS hands it (`accept` binds to the
 * <input> only, never to drops) and the .iif export usually sits beside the
 * company file and its backups. Without this, dragging a 400 MB .QBB in by
 * mistake materialised the whole file as an ArrayBuffer, decoded it again as
 * text, and only then hit the size rule -- a multi-second main-thread freeze
 * ending in the wrong message ("this looks like a UTF-16 re-save"), which
 * sends the customer off re-saving a binary backup in Notepad.
 *
 * Returns null when the file is worth reading.
 */
export function checkIifFileMeta(file: { name: string; size: number }): IifFileMetaProblem | null {
  if (QB_BINARY_EXTENSION.test(file.name)) return { kind: 'notAnIifFile' };
  // Chrome/Edge put a dropped FOLDER into dataTransfer.files as a zero-byte
  // entry whose read rejects; a genuinely empty export lands here too.
  if (file.size === 0) return { kind: 'emptyOrFolder' };
  if (file.size > MAX_IIF_FILE_BYTES) {
    return { kind: 'tooLarge', sizeMb: (file.size / 1e6).toFixed(1) };
  }
  return null;
}

export function decodeIifBuffer(buffer: ArrayBuffer): { text: string } | { error: string } {
  const bytes = new Uint8Array(buffer);
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buffer);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buffer);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      text = new TextDecoder('windows-1252').decode(buffer);
    }
  }
  if (text.includes(String.fromCharCode(0))) {
    return {
      error:
        'This file looks like a UTF-16 ("Unicode Text") re-save, which scrambles the import. ' +
        'Upload the original .iif file exported by QuickBooks, or re-save this one as ANSI or ' +
        'UTF-8 text and try again.',
    };
  }
  return { text };
}
