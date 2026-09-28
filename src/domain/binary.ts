/** Base64 / data-URI handling for binary note bodies and attachments. */
import { DomainError } from './errors.js';

export interface DecodedBinary {
  bytes: Buffer;
  /** Mime type carried by a data: URI, when one was given. */
  mime?: string;
}

const DATA_URI = /^data:([^;,]*)((?:;[^;,]+)*),/i;

/**
 * Decode caller-supplied binary content. Accepts standard base64 (whitespace
 * tolerated) or a `data:` URI. The size check runs on the encoded length first
 * so an oversized payload is rejected before any allocation of its size.
 */
export function decodeBinaryInput(input: string, maxBytes: number, where: string): DecodedBinary {
  let encoded = input;
  let mime: string | undefined;
  const dataUri = DATA_URI.exec(input);
  if (dataUri) {
    const params = dataUri[2] ?? '';
    if (!/;base64$/i.test(params)) {
      throw DomainError.validation(`${where}: only base64-encoded data: URIs are supported`);
    }
    mime = dataUri[1] ? dataUri[1].toLowerCase() : undefined;
    encoded = input.slice(dataUri[0].length);
  }
  encoded = encoded.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw DomainError.validation(`${where}: content is not valid base64`);
  }
  // Padding must agree with the data length (AUDIT R16): 4k data characters take
  // none, 4k+2 take '==', 4k+3 take '=' (or none, for unpadded input), and 4k+1
  // is impossible. Node's decoder would silently accept anything else.
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const dataLength = encoded.length - padding;
  if (dataLength === 0) throw DomainError.validation(`${where}: binary content is empty`);
  const remainder = dataLength % 4;
  const validPadding =
    remainder === 0
      ? padding === 0
      : remainder === 2
        ? padding !== 1
        : remainder === 3
          ? padding !== 2
          : false;
  if (!validPadding) {
    throw DomainError.validation(`${where}: content is not valid base64 (malformed padding)`);
  }
  const decodedLength = Math.floor((dataLength * 3) / 4);
  if (decodedLength > maxBytes) {
    throw new DomainError(
      'TOO_LARGE',
      `${where}: decoded content is ${decodedLength} bytes; the limit is ${maxBytes} bytes`,
      { bytes: decodedLength, maxBytes },
    );
  }
  const bytes = Buffer.from(encoded, 'base64');
  // Defense in depth: the estimate above is exact for validated input.
  if (bytes.length !== decodedLength || bytes.length > maxBytes) {
    throw DomainError.validation(`${where}: content is not valid base64`);
  }
  return mime !== undefined ? { bytes, mime } : { bytes };
}

const TEXT_MIME =
  /^(text\/|application\/(json|xml|javascript|x-javascript|yaml|x-yaml|toml|sql|x-sh|csv)$)|[+/](json|xml)$/i;

/** Mime types whose bodies are returned as UTF-8 text instead of base64. */
export function isTextMime(mime: string): boolean {
  return TEXT_MIME.test(mime.trim());
}

export function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime.trim());
}

/** Trilium's attachment role for a mime type ('image' shows inline in the note editor). */
export function defaultAttachmentRole(mime: string): string {
  return isImageMime(mime) ? 'image' : 'file';
}
