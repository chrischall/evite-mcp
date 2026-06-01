import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { EviteClient } from '../client.js';

// ────────────────────────────────────────────────────────────────────────────
// Confirm-gated write tools.
//
// SAFETY MODEL: every tool here takes `confirm` (schemaConfirm). The DEFAULT —
// `confirm` absent or false — performs NO network call and returns a dry-run
// PREVIEW of exactly what would happen. Only `confirm: true` reaches the client
// write methods (which themselves are the only thing that mutates Evite).
//
// The underlying write PAYLOADS are UNVERIFIED — no live compose-capture exists
// yet (issue #3). Each tool's description and preview flag this so a caller who
// confirms knows the live path is provisional.
// ────────────────────────────────────────────────────────────────────────────

/** Common shared note flagged into previews of unverified writes. */
const UNVERIFIED_NOTE =
  'Live write payload is UNVERIFIED (pending a compose-capture, issue #3).';

/**
 * Build a dry-run preview result. Returned whenever `confirm` is not true — no
 * network call is made. Includes a `preview` marker, the action, and the exact
 * values that WOULD be sent, plus a reminder to pass `confirm: true`.
 */
function preview(action: string, details: Record<string, unknown>): ReturnType<typeof textResult> {
  return textResult({
    preview: true,
    action,
    note: `DRY RUN — nothing was sent. Re-run with confirm: true to perform this write. ${UNVERIFIED_NOTE}`,
    wouldSend: details,
  });
}

const rsvpArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  guest_id: z.string().min(1).describe('Guest id to RSVP for (guestId from evite_list_guests).'),
  response: z.enum(['yes', 'no', 'maybe']).describe('RSVP response.'),
  number_of_adults: z.number().int().nonnegative().describe('Number of adults attending.'),
  number_of_kids: z.number().int().nonnegative().describe('Number of kids attending.'),
  note: z.string().optional().describe('Optional note/comment to leave with the RSVP.'),
  confirm: schemaConfirm,
});

const sendMessageArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
  message: z.string().min(1).describe('Message text to post to the event Messages thread.'),
  confirm: schemaConfirm,
});

const createEventArgs = z.object({
  title: z.string().min(1).describe('Event title.'),
  start_datetime: z.string().optional().describe('Start datetime (ISO 8601, event-local).'),
  end_datetime: z.string().optional().describe('End datetime (ISO 8601, event-local).'),
  message: z.string().optional().describe('Event message / description.'),
  confirm: schemaConfirm,
});

const updateEventArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id to edit (event_id from evite_list_events).'),
  title: z.string().optional().describe('New title.'),
  start_datetime: z.string().optional().describe('New start datetime (ISO 8601).'),
  end_datetime: z.string().optional().describe('New end datetime (ISO 8601).'),
  message: z.string().optional().describe('New event message / description.'),
  confirm: schemaConfirm,
});

export function registerWriteTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_rsvp',
    {
      description:
        'RSVP for a guest on an Evite event. Confirm-gated: without confirm:true this returns a ' +
        'dry-run preview and sends nothing. ' +
        UNVERIFIED_NOTE,
      annotations: toolAnnotations({ title: 'RSVP to an Evite event', readOnly: false }),
      inputSchema: rsvpArgs.shape,
    },
    async (raw) => {
      const args = rsvpArgs.parse(raw);
      if (args.confirm !== true) {
        return preview('rsvp', {
          event_id: args.event_id,
          guest_id: args.guest_id,
          response: args.response,
          number_of_adults: args.number_of_adults,
          number_of_kids: args.number_of_kids,
          note: args.note,
        });
      }
      const data = await client.rsvp(args.event_id, args.guest_id, {
        response: args.response,
        numberOfAdults: args.number_of_adults,
        numberOfKids: args.number_of_kids,
        note: args.note,
      });
      return textResult(data);
    },
  );

  server.registerTool(
    'evite_send_message',
    {
      description:
        "Post a message to an Evite event's Messages thread. Confirm-gated: without confirm:true " +
        'this returns a dry-run preview and sends nothing. ' +
        UNVERIFIED_NOTE,
      annotations: toolAnnotations({ title: 'Message Evite event guests', readOnly: false }),
      inputSchema: sendMessageArgs.shape,
    },
    async (raw) => {
      const args = sendMessageArgs.parse(raw);
      if (args.confirm !== true) {
        return preview('send_message', { event_id: args.event_id, message: args.message });
      }
      const data = await client.sendMessage(args.event_id, { message: args.message });
      return textResult(data);
    },
  );

  server.registerTool(
    'evite_create_event',
    {
      description:
        'Create an Evite event. Confirm-gated: without confirm:true this returns a dry-run preview ' +
        'and sends nothing. NOTE: the real Evite create flow is a multi-step wizard, so this ' +
        'single-step create is best-effort. ' +
        UNVERIFIED_NOTE,
      annotations: toolAnnotations({ title: 'Create an Evite event', readOnly: false }),
      inputSchema: createEventArgs.shape,
    },
    async (raw) => {
      const args = createEventArgs.parse(raw);
      if (args.confirm !== true) {
        return preview('create_event', {
          title: args.title,
          start_datetime: args.start_datetime,
          end_datetime: args.end_datetime,
          message: args.message,
          caveat: 'Create is multi-step in the Evite wizard — single-step create is UNVERIFIED.',
        });
      }
      const data = await client.createEvent({
        title: args.title,
        startDatetime: args.start_datetime,
        endDatetime: args.end_datetime,
        message: args.message,
      });
      return textResult(data);
    },
  );

  server.registerTool(
    'evite_update_event',
    {
      description:
        'Edit an existing Evite event (only the fields you pass change). Confirm-gated: without ' +
        'confirm:true this returns a dry-run preview and sends nothing. ' +
        UNVERIFIED_NOTE,
      annotations: toolAnnotations({ title: 'Edit an Evite event', readOnly: false }),
      inputSchema: updateEventArgs.shape,
    },
    async (raw) => {
      const args = updateEventArgs.parse(raw);

      // Build the patch from only the provided fields (map snake_case → wire).
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.start_datetime !== undefined) patch.startDatetime = args.start_datetime;
      if (args.end_datetime !== undefined) patch.endDatetime = args.end_datetime;
      if (args.message !== undefined) patch.message = args.message;

      if (Object.keys(patch).length === 0) {
        throw new Error('evite_update_event: provide at least one field to change.');
      }

      if (args.confirm !== true) {
        return preview('update_event', { event_id: args.event_id, patch });
      }
      const data = await client.updateEvent(args.event_id, patch);
      return textResult(data);
    },
  );
}
