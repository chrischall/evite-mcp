import { isHostedEnv, resolveUploadSource, type UploadSource } from '@chrischall/mcp-utils/export';
import { IMAGE_EXT_MIME, IMAGE_MIMETYPES, MAX_UPLOAD_BYTES } from './image-meta.js';
import { confineUploadPath, uploadRoots } from './upload-path.js';

/** The read-only tool that mints upload slots for `blob_key` (src/tools/uploads.ts). */
export const UPLOAD_SLOT_TOOL = 'evite_upload_slots';

/** A photo passed inline, in this server's parameter spelling. */
export interface InlinePhoto {
  filename: string;
  content_base64: string;
}

/** The photo arguments of `evite_upload_photo`: exactly one of path / inline / blob_key. */
export interface PhotoSourceArgs {
  path?: string;
  inline?: InlinePhoto;
  blob_key?: string;
  /** Declared image type; for inline it is the type the bytes must match. */
  mimetype?: string;
}

/** A resolved photo, plus the absolute path read when it came from disk. */
export interface PhotoSource {
  source: UploadSource;
  resolvedPath?: string;
}

/**
 * Resolve `evite_upload_photo`'s file from exactly one of three routes, via
 * mcp-utils' `resolveUploadSource` (image types only, Evite's 20 MB cap):
 *
 *  - **path** — a local install's file, confined to EVITE_UPLOAD_DIR. The
 *    repo's own `confineUploadPath` runs first, so the outside/hidden refusals
 *    (and their EVITE_UPLOAD_DIR hint) are unchanged; then the shared guard
 *    re-confines to the same roots, refuses symlinks and non-image extensions,
 *    and reads the bytes from one no-follow descriptor. On a hosted
 *    deployment a path is refused by `resolveUploadSource` itself, pointing at
 *    the slot flow — nothing on that machine is the caller's.
 *  - **inline** — base64, decoded strictly.
 *  - **blob_key** — a file the caller PUT to an upload slot. Reading it never
 *    deletes it; the caller calls `source.release()` after Evite accepts it.
 *
 * Every route ends in bytes whose magic number matches an image type, and a
 * `sha256` the confirmation binds.
 */
export async function resolvePhotoSource(args: PhotoSourceArgs): Promise<PhotoSource> {
  const hosted = isHostedEnv();
  const onlyPath = args.path !== undefined && args.inline === undefined && args.blob_key === undefined;
  const resolvedPath = onlyPath && !hosted ? confineUploadPath(args.path!) : undefined;
  const source = await resolveUploadSource(
    {
      ...(args.path !== undefined ? { path: resolvedPath ?? args.path } : {}),
      ...(args.inline !== undefined
        ? {
            inline: {
              filename: args.inline.filename,
              contentBase64: args.inline.content_base64,
              ...(args.mimetype !== undefined ? { mimeType: args.mimetype } : {}),
            },
          }
        : {}),
      ...(args.blob_key !== undefined ? { blobKey: args.blob_key } : {}),
    },
    {
      maxBytes: MAX_UPLOAD_BYTES,
      allowedMimeTypes: IMAGE_MIMETYPES,
      path: { mimeByExt: IMAGE_EXT_MIME, allowedRoots: uploadRoots(), denyHiddenSegments: true },
      hosted,
      names: { path: 'path', inline: 'inline', blobKey: 'blob_key', slotTool: UPLOAD_SLOT_TOOL },
    },
  );
  return { source, ...(resolvedPath !== undefined ? { resolvedPath } : {}) };
}
