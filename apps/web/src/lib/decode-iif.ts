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
