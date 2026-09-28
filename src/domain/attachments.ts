/**
 * Trilium attachments: binary or text blobs owned by a note (images pasted
 * into a text note, files attached to it). Content writes are hash-protected
 * like note content.
 */
import { trimUtf8, type TriliumClient } from '../etapi/client.js';
import { EtapiError } from '../etapi/errors.js';
import type { EtapiAttachment } from '../etapi/types.js';
import { decodeBinaryInput, defaultAttachmentRole, isImageMime, isTextMime } from './binary.js';
import { DomainError } from './errors.js';
import { KeyedMutex } from './keyedMutex.js';
import { toNoteSummary, type NoteSummary } from './model.js';
import type { ServiceLimits } from './services.js';
import { fetchNote } from './shared.js';

export interface AttachmentView {
  attachmentId: string;
  ownerNoteId: string;
  role: string;
  mime: string;
  title: string;
  position: number;
  contentHash: string;
  contentLength?: number;
  utcDateModified?: string;
  scheduledForErasure: boolean;
}

export interface GetAttachmentInput {
  attachmentId: string;
  includeContent?: boolean | undefined;
  maxContentBytes?: number | undefined;
}

export interface GetAttachmentResult {
  attachment: AttachmentView;
  /** UTF-8 text for text-like mime types. */
  content?: string;
  /** Base64 for everything else. */
  contentBase64?: string;
  contentBytes?: number;
  contentTruncated?: boolean;
  contentOmittedReason?: string;
  isImage: boolean;
}

export interface CreateAttachmentInput {
  noteId: string;
  title: string;
  mime: string;
  role?: string | undefined;
  content?: string | undefined;
  contentBase64?: string | undefined;
  position?: number | undefined;
}

export interface UpdateAttachmentInput {
  attachmentId: string;
  title?: string | undefined;
  mime?: string | undefined;
  role?: string | undefined;
  position?: number | undefined;
  content?: string | undefined;
  contentBase64?: string | undefined;
  /** Required when replacing content: contentHash from list_attachments/get_attachment. */
  expectedHash?: string | undefined;
}

export interface UpdateAttachmentResult {
  attachment: AttachmentView;
  changed: string[];
  previousHash?: string;
}

export function toAttachmentView(a: EtapiAttachment): AttachmentView {
  return {
    attachmentId: a.attachmentId,
    ownerNoteId: a.ownerId,
    role: a.role,
    mime: a.mime,
    title: a.title,
    position: a.position ?? 0,
    contentHash: a.blobId,
    ...(typeof a.contentLength === 'number' ? { contentLength: a.contentLength } : {}),
    ...(a.utcDateModified ? { utcDateModified: a.utcDateModified } : {}),
    scheduledForErasure: Boolean(a.utcDateScheduledForErasureSince),
  };
}

export class AttachmentsService {
  private readonly mutex: KeyedMutex;

  constructor(
    private readonly client: TriliumClient,
    private readonly limits: ServiceLimits,
    mutex?: KeyedMutex,
  ) {
    this.mutex = mutex ?? new KeyedMutex();
  }

  async list(noteId: string): Promise<{ note: NoteSummary; attachments: AttachmentView[] }> {
    const note = await fetchNote(this.client, noteId);
    let attachments: EtapiAttachment[];
    try {
      attachments = await this.client.listAttachments(noteId);
    } catch (err) {
      throw DomainError.from(err, `list attachments of ${noteId}`);
    }
    return {
      note: toNoteSummary(note),
      attachments: attachments
        .filter((a) => !a.utcDateScheduledForErasureSince)
        .map(toAttachmentView),
    };
  }

  async get(input: GetAttachmentInput): Promise<GetAttachmentResult> {
    const raw = await this.fetch(input.attachmentId);
    const attachment = toAttachmentView(raw);
    const result: GetAttachmentResult = { attachment, isImage: isImageMime(raw.mime) };
    if (input.includeContent === false) return result;
    if (raw.title === '[protected]') {
      result.contentOmittedReason = 'Attachment is protected; ETAPI cannot read protected content';
      return result;
    }
    const maxBytes = Math.min(
      input.maxContentBytes ?? this.limits.defaultReadContentBytes,
      this.limits.maxReadContentBytes,
    );
    let bounded;
    try {
      bounded = await this.client.readAttachmentContent(input.attachmentId, maxBytes);
    } catch (err) {
      throw DomainError.from(err, `read attachment ${input.attachmentId}`);
    }
    if (bounded.totalBytes !== undefined) result.contentBytes = bounded.totalBytes;
    if (isTextMime(raw.mime)) {
      // A cut never splits a code point (AUDIT R14).
      result.content = (bounded.truncated ? trimUtf8(bounded.bytes) : bounded.bytes).toString(
        'utf8',
      );
      result.contentTruncated = bounded.truncated;
      return result;
    }
    if (bounded.truncated) {
      // A cut binary body is useless; say how big it is instead.
      result.contentOmittedReason = `Binary content exceeds maxContentBytes (${maxBytes}); raise it up to ${this.limits.maxReadContentBytes} or use Trilium directly`;
      return result;
    }
    result.contentBase64 = bounded.bytes.toString('base64');
    result.contentTruncated = false;
    return result;
  }

  async create(
    input: CreateAttachmentInput,
  ): Promise<{ attachment: AttachmentView; note: NoteSummary }> {
    const note = await fetchNote(this.client, input.noteId);
    const title = input.title.trim();
    if (!title) throw DomainError.validation('title must not be empty');
    const body = this.bodyOf(input, 'create_attachment');
    const mime = (input.mime || body.mime || '').trim();
    if (!mime) throw DomainError.validation('mime is required (e.g. image/png, application/pdf)');
    const role = input.role?.trim() || defaultAttachmentRole(mime);
    let created: EtapiAttachment;
    try {
      created = await this.client.createAttachment({
        ownerId: input.noteId,
        role,
        mime,
        title,
        ...(typeof body.data === 'string' ? { content: body.data } : { content: '' }),
        ...(input.position !== undefined ? { position: input.position } : {}),
      });
    } catch (err) {
      throw DomainError.from(err, `create attachment on ${input.noteId}`);
    }
    if (typeof body.data !== 'string') {
      try {
        await this.client.putAttachmentContent(created.attachmentId, body.data);
      } catch (err) {
        throw DomainError.from(
          err,
          `upload content of attachment ${created.attachmentId} (the attachment exists but is empty)`,
        );
      }
    }
    return {
      attachment: toAttachmentView(await this.fetch(created.attachmentId)),
      note: toNoteSummary(note),
    };
  }

  update(input: UpdateAttachmentInput): Promise<UpdateAttachmentResult> {
    return this.mutex.run(`attachment:${input.attachmentId}`, () => this.updateUnlocked(input));
  }

  private async updateUnlocked(input: UpdateAttachmentInput): Promise<UpdateAttachmentResult> {
    const current = await this.fetch(input.attachmentId);
    // Trilium persists blank mime/role and then cannot load the attachment again
    // (AUDIT R11), so every provided field is validated before any mutation.
    const patch: { title?: string; mime?: string; role?: string; position?: number } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw DomainError.validation('title must not be empty');
      patch.title = title;
    }
    if (input.mime !== undefined) {
      const mime = input.mime.trim();
      if (!mime) throw DomainError.validation('mime must not be empty');
      patch.mime = mime;
    }
    if (input.role !== undefined) {
      const role = input.role.trim();
      if (!role) throw DomainError.validation("role must not be empty ('file' or 'image')");
      patch.role = role;
    }
    if (input.position !== undefined) patch.position = input.position;
    const hasContent = input.content !== undefined || input.contentBase64 !== undefined;
    if (!hasContent && Object.keys(patch).length === 0) {
      throw DomainError.validation(
        'Provide at least one of title, mime, role, position, content, contentBase64',
      );
    }
    // Decode (and size-check) new content before touching anything.
    const body = hasContent ? this.bodyOf(input, 'update_attachment') : undefined;
    const changed: string[] = [];
    let previousHash: string | undefined;
    if (body) {
      if (!input.expectedHash) {
        throw DomainError.validation(
          'Replacing attachment content requires expectedHash (contentHash from get_attachment)',
        );
      }
      if (current.blobId !== input.expectedHash) {
        throw new DomainError(
          'CONFLICT',
          `Attachment '${current.attachmentId}' has changed since it was read (current hash ${current.blobId}, expected ${input.expectedHash}). Read it again and retry.`,
          {
            attachmentId: current.attachmentId,
            currentHash: current.blobId,
            expectedHash: input.expectedHash,
          },
        );
      }
      if (body.mime && input.mime === undefined && body.mime !== current.mime)
        patch.mime = body.mime;
      try {
        await this.client.putAttachmentContent(current.attachmentId, body.data);
      } catch (err) {
        throw DomainError.from(err, `write content of attachment ${current.attachmentId}`);
      }
      previousHash = current.blobId;
      changed.push('content');
    }
    if (Object.keys(patch).length > 0) {
      try {
        await this.client.patchAttachment(current.attachmentId, patch);
      } catch (err) {
        throw DomainError.from(err, `update attachment ${current.attachmentId}`);
      }
      changed.push(...Object.keys(patch));
    }
    return {
      attachment: toAttachmentView(await this.fetch(current.attachmentId)),
      changed,
      ...(previousHash !== undefined ? { previousHash } : {}),
    };
  }

  async delete(attachmentId: string): Promise<{ attachment: AttachmentView; deleted: boolean }> {
    const current = await this.fetch(attachmentId);
    try {
      await this.client.deleteAttachment(attachmentId);
    } catch (err) {
      throw DomainError.from(err, `delete attachment ${attachmentId}`);
    }
    return { attachment: toAttachmentView(current), deleted: true };
  }

  private async fetch(attachmentId: string): Promise<EtapiAttachment> {
    try {
      return await this.client.getAttachment(attachmentId);
    } catch (err) {
      if (err instanceof EtapiError && err.isNotFound)
        throw DomainError.notFound('Attachment', attachmentId);
      throw DomainError.from(err, `get attachment ${attachmentId}`);
    }
  }

  /** Exactly one of content (text) or contentBase64 (binary / data URI). */
  private bodyOf(
    input: { content?: string | undefined; contentBase64?: string | undefined },
    where: string,
  ): { data: string | Buffer; mime?: string } {
    if (input.content !== undefined && input.contentBase64 !== undefined) {
      throw DomainError.validation(`${where}: pass either content or contentBase64, not both`);
    }
    if (input.contentBase64 !== undefined) {
      const decoded = decodeBinaryInput(
        input.contentBase64,
        this.limits.maxWriteContentBytes,
        where,
      );
      return decoded.mime !== undefined
        ? { data: decoded.bytes, mime: decoded.mime }
        : { data: decoded.bytes };
    }
    const text = input.content ?? '';
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.limits.maxWriteContentBytes) {
      throw new DomainError(
        'TOO_LARGE',
        `${where}: content is ${bytes} bytes; the limit is ${this.limits.maxWriteContentBytes} bytes`,
        { bytes, maxBytes: this.limits.maxWriteContentBytes },
      );
    }
    return { data: text };
  }
}
