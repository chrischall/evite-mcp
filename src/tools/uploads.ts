import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import {
  blobStoreFromEnv,
  MAX_UPLOAD_FILES,
  mintUploadSlot,
  resolveUploadMime,
  sanitizeUploadFilename,
} from '@chrischall/mcp-utils/export';
import type { EviteClient } from '../client.js';
import { IMAGE_MIMETYPES } from '../image-meta.js';
import { UPLOAD_SLOT_TOOL } from '../photo-source.js';
import { familyMeta } from './hints.js';

// ────────────────────────────────────────────────────────────────────────────
// Upload slots — how a hosted caller gets a photo to evite_upload_photo.
//
// A server on mcp-host shares no filesystem with its caller, so a `path` cannot
// work there. This tool mints a signed PUT URL per photo on the deployment's
// blob store; the caller PUTs the file to it, then passes the slot's blobKey to
// evite_upload_photo as `blob_key`. Minting touches neither Evite nor the
// network, so the tool is read-only; the upload itself is the confirmed write.
// ────────────────────────────────────────────────────────────────────────────

const slotArgs = z.object({
  files: z
    .array(
      z.object({
        filename: z
          .string()
          .min(1)
          .describe('Filename to store the photo under — a bare name with an image extension, e.g. "photo.jpg".'),
        mimetype: z
          .enum(IMAGE_MIMETYPES)
          .optional()
          .describe('Image type. Default: from the filename extension. The PUT must send exactly this Content-Type.'),
      }),
    )
    .min(1)
    .max(MAX_UPLOAD_FILES)
    .describe(`The photos to upload, one slot each (at most ${MAX_UPLOAD_FILES}).`),
});

export function registerUploadTools(server: McpServer, _client: EviteClient): void {
  server.registerTool(
    UPLOAD_SLOT_TOOL,
    {
      _meta: familyMeta('other', { aliases: ['photo upload link'] }),
      description:
        'Get upload links for photos to add to an Evite event album — the way to send a photo on the hosted ' +
        'connector, which cannot read files on your machine. Returns one slot per file: PUT the file to its ' +
        'uploadUrl (the returned curl command does it, with the exact Content-Type), then call evite_upload_photo ' +
        'with the slot\'s blobKey as blob_key. Links expire after 30 minutes. Changes nothing on Evite. ' +
        'Unavailable on a local install — pass path or inline to evite_upload_photo there.',
      annotations: toolAnnotations({ title: 'Get photo upload links', readOnly: true, openWorld: false }),
      inputSchema: slotArgs,
    },
    async (args) => {
      const store = blobStoreFromEnv();
      if (!store) {
        throw new McpToolError(
          `${UPLOAD_SLOT_TOOL} needs the blob store a hosted deployment provides, and this server has no blob store.`,
          {
            hint:
              'Pass the photo to evite_upload_photo directly instead: path (a file in EVITE_UPLOAD_DIR) or ' +
              'inline (base64).',
          },
        );
      }
      const slots = args.files.map((f) => {
        const filename = sanitizeUploadFilename(f.filename);
        const mimeType = resolveUploadMime(filename, f.mimetype);
        if (!IMAGE_MIMETYPES.includes(mimeType)) {
          throw new McpToolError(
            `${filename}: ${mimeType} is not a photo — only images (${IMAGE_MIMETYPES.join(', ')}) can be added to an event album.`,
          );
        }
        return mintUploadSlot(store, { filename, mimeType });
      });
      return minifiedResult({
        slots,
        next:
          'PUT each file to its uploadUrl (run its curl command with the real file path), then call ' +
          'evite_upload_photo with event_id, guest_id and blob_key = the slot\'s blobKey. Each upload is ' +
          'deleted once Evite accepts the photo.',
      });
    },
  );
}
