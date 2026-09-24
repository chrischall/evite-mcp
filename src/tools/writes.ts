import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  confirmationFromEnv,
  confirmTokenParam,
  minifiedResult,
  requireConfirmationWithFallback,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import { statSync } from 'node:fs';
import { resolveUploadPath, type EviteClient } from '../client.js';
import { IMAGE_MIMETYPES } from '../image-meta.js';

// ────────────────────────────────────────────────────────────────────────────
// Confirmed write tools.
//
// SAFETY MODEL: every tool here asks the user to confirm before it reaches the
// client write methods (the only thing that mutates Evite), via mcp-utils'
// requireConfirmationWithFallback:
//   - a client that supports elicitation gets a real confirmation prompt;
//   - otherwise (claude.ai, Claude Desktop) the first call performs NO network
//     call and returns the preview plus a `confirmToken`; only a repeat call
//     with that token — bound to this tool and the exact payload, single-use,
//     expiring — performs the write. MCP_CONFIRM_MODE (ask-user | auto | refuse)
//     picks how that fallback behaves.
//
// These are REAL mutations — an RSVP, a broadcast, a created/edited event —
// so the confirmation keeps a human in the loop. The endpoints are live-verified
// (see docs/EVITE-API.md), and the two formerly-assumed request bodies were
// pinned from Evite's own bundles on 2026-07-30 (issue #3): `send` posts no
// body, and per-guest messaging turned out to be a Firebase RTDB push rather
// than an evite.com endpoint — `evite_send_message` now performs that push over
// RTDB's REST API (see EviteClient.sendMessage).
// ────────────────────────────────────────────────────────────────────────────

/** The sentence every write tool's description ends with. */
const CONFIRM_NOTE =
  'Asks the user to confirm first: a confirmation prompt where the client supports one; ' +
  'otherwise the first call returns a preview and a confirmToken, and only a repeat call ' +
  'with that token proceeds (see MCP_CONFIRM_MODE).';

interface WriteGate {
  /** The tool name the token is bound to. */
  tool: string;
  /** `evite.<verb>`. */
  action: string;
  /** Prompt text shown above the preview. */
  message: string;
  /** The primary id acted on ('' for a create). */
  target: string;
  /** Exactly what the client write will receive — hashed into the token. */
  payload: unknown;
  /** The values shown to the user (the tool's own argument names). */
  wouldSend: Record<string, unknown>;
  /** Optional warning shown with the preview. */
  caveat?: string;
}

/**
 * Gate a write on the user's confirmation. `undefined` means proceed; anything
 * else is the result to return unchanged (a prompt, a phase-1 preview + token,
 * or a refusal). Call it on EVERY invocation with the freshly-built payload, so
 * a change between the preview and the token call is refused as DRAFT_CHANGED.
 */
function confirmWrite(ctx: ServerContext, confirmToken: string | undefined, gate: WriteGate) {
  const preview: Record<string, unknown> = {
    wouldSend: gate.wouldSend,
    ...(gate.caveat ? { caveat: gate.caveat } : {}),
  };
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: gate.action,
      message: gate.message,
      details: preview,
      tool: gate.tool,
      confirmToken,
      subject: () => ({ target: gate.target, payload: gate.payload, preview }),
    }),
  );
}

const rsvpArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guest_id: z.string().min(1).describe('Guest id to RSVP for (guestId from evite_list_guests).'),
  response: z.enum(['yes', 'no', 'maybe']).describe('RSVP response.'),
  number_of_adults: z.number().int().nonnegative().describe('Number of adults attending.'),
  number_of_kids: z.number().int().nonnegative().describe('Number of kids attending.'),
  note: z.string().optional().describe('Optional note/comment to leave with the RSVP.'),
  confirmToken: confirmTokenParam,
});

const sendMessageArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guest_id: z.string().min(1).describe('Guest id to message (guestId from evite_list_guests).'),
  message: z.string().min(1).describe('Message text to send to the guest.'),
  confirmToken: confirmTokenParam,
});

const broadcastArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  message: z.string().min(1).describe('Message text to broadcast to the selected RSVP segments.'),
  groups: z
    .array(z.string().min(1))
    .min(1)
    .describe("RSVP segments to send to, e.g. ['yes','no','maybe']."),
  participant_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Optional recipient count the web UI sends along (informational).'),
  confirmToken: confirmTokenParam,
});

const uploadPhotoArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guest_id: z
    .string()
    .min(1)
    .describe("Your guest id on the event (guestId from evite_list_guests — your own row, guestType host/cohost/guest)."),
  path: z
    .string()
    .min(1)
    .describe('Path to the local image file to upload (a leading ~ is expanded). JPEG/PNG/GIF/WebP/HEIC, max 20 MB.'),
  mimetype: z
    .enum(IMAGE_MIMETYPES)
    .optional()
    .describe(
      'Override the image mimetype (otherwise inferred from the file). Must match the file contents.',
    ),
  confirmToken: confirmTokenParam,
});

const createEventArgs = z.object({
  title: z.string().min(1).describe('Event title.'),
  start_datetime: z.string().min(1).describe('Start datetime (ISO 8601, event-local). Required.'),
  template_name: z
    .string()
    .min(1)
    .describe('Invitation template name (required by the create API; e.g. a gallery design id).'),
  end_datetime: z.string().optional().describe('End datetime (ISO 8601, event-local).'),
  message: z.string().optional().describe('Event message / description.'),
  confirmToken: confirmTokenParam,
});

const updateEventArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id to edit (event_id from evite_list_events).'),
  title: z.string().optional().describe('New title.'),
  start_datetime: z.string().optional().describe('New start datetime (ISO 8601).'),
  end_datetime: z.string().optional().describe('New end datetime (ISO 8601).'),
  message: z.string().optional().describe('New event message / description.'),
  confirmToken: confirmTokenParam,
});

const addGuestArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guests: z
    .array(
      z.object({
        name: z.string().min(1).describe('Guest name.'),
        email: z.string().min(1).describe('Guest email address.'),
      }),
    )
    .min(1)
    .describe('Guests to add to the draft (un-sent) list.'),
  confirmToken: confirmTokenParam,
});

const updateGuestArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guest_id: z.string().min(1).describe('Draft guest id to edit (guest_id from the guest list).'),
  name: z.string().min(1).describe('New guest name.'),
  email: z.string().min(1).describe('New guest email address.'),
  phone: z.string().optional().describe('New guest phone (optional).'),
  confirmToken: confirmTokenParam,
});

const removeGuestArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guest_id: z.string().min(1).describe('Draft guest id to remove (guest_id from the guest list).'),
  confirmToken: confirmTokenParam,
});

/** Shared schema for the event-lifecycle tools that take only an event id. */
const eventIdArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  confirmToken: confirmTokenParam,
});

export function registerWriteTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_rsvp',
    {
      description: `RSVP for a guest on an Evite event. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'RSVP to an Evite event', readOnly: false, destructive: true }),
      inputSchema: rsvpArgs,
    },
    async (args, ctx) => {
      const rsvp = {
        response: args.response,
        numberOfAdults: args.number_of_adults,
        numberOfKids: args.number_of_kids,
        note: args.note,
      };
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_rsvp',
        action: 'evite.rsvp',
        message: 'Review and confirm this RSVP:',
        target: args.event_id,
        payload: { eventId: args.event_id, guestId: args.guest_id, rsvp },
        wouldSend: {
          event_id: args.event_id,
          guest_id: args.guest_id,
          response: args.response,
          number_of_adults: args.number_of_adults,
          number_of_kids: args.number_of_kids,
          note: args.note,
        },
      });
      if (gate) return gate;
      const data = await client.rsvp(args.event_id, args.guest_id, rsvp);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_send_message',
    {
      description:
        'Send a private message to one Evite event guest. This really notifies the guest. ' +
        'Sent as the event host (Evite delivers per-guest chat over Firebase, not REST), so ' +
        `only a host can use it. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Message an Evite event guest', readOnly: false, destructive: true }),
      inputSchema: sendMessageArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_send_message',
        action: 'evite.send_message',
        message: 'Review and confirm this message to a guest:',
        target: args.event_id,
        payload: { eventId: args.event_id, guestId: args.guest_id, message: args.message },
        wouldSend: { event_id: args.event_id, guest_id: args.guest_id, message: args.message },
        caveat:
          'Delivered as a Firebase RTDB push (Evite has no REST endpoint for per-guest chat); ' +
          'sent as the event host.',
      });
      if (gate) return gate;
      const data = await client.sendMessage(args.event_id, args.guest_id, { message: args.message });
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_broadcast',
    {
      description:
        'Broadcast a message to whole RSVP segments of an Evite event at once (e.g. everyone ' +
        `who replied yes/maybe). This really emails every guest in those segments. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Broadcast to Evite RSVP segments', readOnly: false, destructive: true }),
      inputSchema: broadcastArgs,
    },
    async (args, ctx) => {
      const body = {
        message: args.message,
        groups: args.groups,
        participantCount: args.participant_count,
      };
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_broadcast',
        action: 'evite.broadcast',
        message: 'Review and confirm this broadcast (it emails every guest in these segments):',
        target: args.event_id,
        payload: { eventId: args.event_id, ...body },
        wouldSend: {
          event_id: args.event_id,
          message: args.message,
          groups: args.groups,
          participant_count: args.participant_count,
        },
      });
      if (gate) return gate;
      const data = await client.broadcast(args.event_id, body);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_upload_photo',
    {
      description:
        "Upload a local image to an Evite event's shared photo gallery. This really adds the " +
        `photo to the event album. Needs your guest_id on the event (from evite_list_guests). ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Upload a photo to an Evite event album', readOnly: false, destructive: false }),
      inputSchema: uploadPhotoArgs,
    },
    async (args, ctx) => {
      // Show exactly which file would be read, so the decision is made on the
      // resolved absolute path and size rather than a relative/~ string. Size
      // and modification time are read on every call and bound into the
      // token, so a file swapped or edited between the preview and the upload
      // (even for one of the same size) is refused as DRAFT_CHANGED.
      const resolved = resolveUploadPath(args.path);
      let size: number | undefined;
      let mtimeMs: number | undefined;
      try {
        ({ size, mtimeMs } = statSync(resolved));
      } catch {
        size = undefined;
        mtimeMs = undefined;
      }
      const upload = { path: args.path, guestId: args.guest_id, mimetype: args.mimetype };
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_upload_photo',
        action: 'evite.upload_photo',
        message: 'Review and confirm this photo upload:',
        target: args.event_id,
        payload: { eventId: args.event_id, ...upload, resolvedPath: resolved, sizeBytes: size, mtimeMs },
        wouldSend: {
          event_id: args.event_id,
          guest_id: args.guest_id,
          path: args.path,
          resolved_path: resolved,
          size_bytes: size,
          mimetype: args.mimetype,
        },
      });
      if (gate) return gate;
      const data = await client.uploadPhoto(args.event_id, upload);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_create_event',
    {
      description:
        'Create an Evite event (as a draft). Requires title, start_datetime, and template_name. ' +
        `${CONFIRM_NOTE} ` +
        'Evite answers a create with a 500 even when the draft IS created; this tool handles that ' +
        'by re-listing your drafts, and returns created:true with the eventId, or created:"unknown" ' +
        'when it cannot confirm — never call it again for the same event; check the drafts instead.',
      annotations: toolAnnotations({ title: 'Create an Evite event', readOnly: false, destructive: false }),
      inputSchema: createEventArgs,
    },
    async (args, ctx) => {
      const input = {
        title: args.title,
        startDatetime: args.start_datetime,
        templateName: args.template_name,
        endDatetime: args.end_datetime,
        message: args.message,
      };
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_create_event',
        action: 'evite.create_event',
        message: 'Review and confirm this new event draft:',
        target: '',
        payload: input,
        wouldSend: {
          title: args.title,
          start_datetime: args.start_datetime,
          template_name: args.template_name,
          end_datetime: args.end_datetime,
          message: args.message,
        },
        caveat:
          'Evite answers a create with a 500 even on success; the tool confirms the new draft ' +
          'itself, so run it once and do not retry.',
      });
      if (gate) return gate;
      const data = await client.createEvent(input);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_update_event',
    {
      description: `Edit an existing Evite event (only the fields you pass change). ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Edit an Evite event', readOnly: false, destructive: false }),
      inputSchema: updateEventArgs,
    },
    async (args, ctx) => {
      // Build the patch from only the provided fields (map snake_case → wire).
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.start_datetime !== undefined) patch.startDatetime = args.start_datetime;
      if (args.end_datetime !== undefined) patch.endDatetime = args.end_datetime;
      if (args.message !== undefined) patch.message = args.message;

      if (Object.keys(patch).length === 0) {
        throw new Error('evite_update_event: provide at least one field to change.');
      }

      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_update_event',
        action: 'evite.update_event',
        message: 'Review and confirm these event changes:',
        target: args.event_id,
        payload: { eventId: args.event_id, patch },
        wouldSend: { event_id: args.event_id, patch },
      });
      if (gate) return gate;
      const data = await client.updateEvent(args.event_id, patch);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_add_guest',
    {
      description:
        "Add guests to an event's draft (un-sent) guest list. Nothing is emailed until you " +
        `evite_send. ${CONFIRM_NOTE} ` +
        'NB: guests only persist on a finalized (sent/sending) event, not a bare new draft.',
      annotations: toolAnnotations({ title: 'Add guests to an Evite event', readOnly: false, destructive: false }),
      inputSchema: addGuestArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_add_guest',
        action: 'evite.add_guest',
        message: 'Review and confirm these guests to add:',
        target: args.event_id,
        payload: { eventId: args.event_id, guests: args.guests },
        wouldSend: { event_id: args.event_id, guests: args.guests },
      });
      if (gate) return gate;
      const data = await client.addGuest(args.event_id, args.guests);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_update_guest',
    {
      description: `Edit a draft (un-sent) guest's name/email/phone on an Evite event. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Edit an Evite guest', readOnly: false, destructive: false }),
      inputSchema: updateGuestArgs,
    },
    async (args, ctx) => {
      const guest = { name: args.name, email: args.email, phone: args.phone };
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_update_guest',
        action: 'evite.update_guest',
        message: 'Review and confirm this guest edit:',
        target: args.guest_id,
        payload: { eventId: args.event_id, guestId: args.guest_id, guest },
        wouldSend: {
          event_id: args.event_id,
          guest_id: args.guest_id,
          name: args.name,
          email: args.email,
          phone: args.phone,
        },
      });
      if (gate) return gate;
      const data = await client.updateGuest(args.event_id, args.guest_id, guest);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_remove_guest',
    {
      description: `Remove a draft (un-sent) guest from an Evite event. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Remove an Evite guest', readOnly: false, destructive: false }),
      inputSchema: removeGuestArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_remove_guest',
        action: 'evite.remove_guest',
        message: 'Review and confirm removing this guest:',
        target: args.guest_id,
        payload: { eventId: args.event_id, guestId: args.guest_id },
        wouldSend: { event_id: args.event_id, guest_id: args.guest_id },
      });
      if (gate) return gate;
      const data = await client.removeGuest(args.event_id, args.guest_id);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_send',
    {
      description:
        'Send the invitation to the ready-to-send (draft) guests of an event ("Send now"). ' +
        `THIS EMAILS GUESTS. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Send an Evite invitation', readOnly: false, destructive: true }),
      inputSchema: eventIdArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_send',
        action: 'evite.send',
        message: 'Review and confirm sending this invitation (it emails guests):',
        target: args.event_id,
        payload: { eventId: args.event_id },
        wouldSend: { event_id: args.event_id },
        caveat: 'THIS EMAILS the event’s ready-to-send guests. Sends no request body (source-verified).',
      });
      if (gate) return gate;
      const data = await client.sendInvitation(args.event_id);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_cancel_event',
    {
      description:
        'Cancel an Evite event (also used to delete a draft). DESTRUCTIVE — may send a ' +
        `cancellation notice to guests; reversible with evite_reinstate_event. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({
        title: 'Cancel an Evite event',
        readOnly: false,
        idempotent: true,
        destructive: true,
      }),
      inputSchema: eventIdArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_cancel_event',
        action: 'evite.cancel_event',
        message: 'Review and confirm cancelling this event:',
        target: args.event_id,
        payload: { eventId: args.event_id },
        wouldSend: { event_id: args.event_id },
        caveat: 'DESTRUCTIVE — cancels the event and may notify guests (reverse with evite_reinstate_event).',
      });
      if (gate) return gate;
      const data = await client.cancelEvent(args.event_id);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_reinstate_event',
    {
      description:
        `Reinstate a previously-cancelled Evite event (the inverse of evite_cancel_event). ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({
        title: 'Reinstate an Evite event',
        readOnly: false,
        idempotent: true,
        destructive: false,
      }),
      inputSchema: eventIdArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_reinstate_event',
        action: 'evite.reinstate_event',
        message: 'Review and confirm reinstating this event:',
        target: args.event_id,
        payload: { eventId: args.event_id },
        wouldSend: { event_id: args.event_id },
      });
      if (gate) return gate;
      const data = await client.reinstateEvent(args.event_id);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'evite_duplicate_event',
    {
      description:
        'Duplicate an Evite event into a fresh draft (the "Duplicate event" action). Returns the ' +
        `new draft event id. ${CONFIRM_NOTE}`,
      annotations: toolAnnotations({ title: 'Duplicate an Evite event', readOnly: false, destructive: false }),
      inputSchema: eventIdArgs,
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, args.confirmToken, {
        tool: 'evite_duplicate_event',
        action: 'evite.duplicate_event',
        message: 'Review and confirm duplicating this event:',
        target: args.event_id,
        payload: { eventId: args.event_id },
        wouldSend: { event_id: args.event_id },
      });
      if (gate) return gate;
      const data = await client.duplicateEvent(args.event_id);
      return minifiedResult(data);
    },
  );
}
