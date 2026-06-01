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
// write methods (the only thing that mutates Evite).
//
// These are REAL mutations — an RSVP, a guest message, a created/edited event —
// so confirm-gating keeps a human in the loop. The endpoints are live-verified
// (see docs/EVITE-API.md); the per-tool `caveat` below flags the few writes whose
// exact request body is still assumed rather than captured.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a dry-run preview result. Returned whenever `confirm` is not true — no
 * network call is made. Includes a `preview` marker, the action, the exact values
 * that WOULD be sent, a reminder to pass `confirm: true`, and an optional caveat.
 */
function preview(
  action: string,
  details: Record<string, unknown>,
  caveat?: string,
): ReturnType<typeof textResult> {
  return textResult({
    preview: true,
    action,
    note: `DRY RUN — nothing was sent. Re-run with confirm: true to perform this write.${
      caveat ? ` ${caveat}` : ''
    }`,
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
  guest_id: z.string().min(1).describe('Guest id to message (guestId from evite_list_guests).'),
  message: z.string().min(1).describe('Message text to send to the guest.'),
  confirm: schemaConfirm,
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
        'dry-run preview and sends nothing.',
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
        'Send a private message to one Evite event guest. This really emails the guest. ' +
        'Confirm-gated: without confirm:true this returns a dry-run preview and sends nothing.',
      annotations: toolAnnotations({ title: 'Message an Evite event guest', readOnly: false }),
      inputSchema: sendMessageArgs.shape,
    },
    async (raw) => {
      const args = sendMessageArgs.parse(raw);
      if (args.confirm !== true) {
        return preview(
          'send_message',
          { event_id: args.event_id, guest_id: args.guest_id, message: args.message },
          'Exact request body is assumed (endpoint verified); see issue #3.',
        );
      }
      const data = await client.sendMessage(args.event_id, args.guest_id, { message: args.message });
      return textResult(data);
    },
  );

  server.registerTool(
    'evite_create_event',
    {
      description:
        'Create an Evite event (as a draft). Requires title, start_datetime, and template_name. ' +
        'Confirm-gated: without confirm:true this returns a dry-run preview and sends nothing. ' +
        'NOTE: the create API returns a 500 even when it succeeds (the draft is created), so this ' +
        'call may throw though the event exists — re-list drafts rather than retrying.',
      annotations: toolAnnotations({ title: 'Create an Evite event', readOnly: false }),
      inputSchema: createEventArgs.shape,
    },
    async (raw) => {
      const args = createEventArgs.parse(raw);
      if (args.confirm !== true) {
        return preview(
          'create_event',
          {
            title: args.title,
            start_datetime: args.start_datetime,
            template_name: args.template_name,
            end_datetime: args.end_datetime,
            message: args.message,
          },
          'Create returns a 500 even on success (the draft IS created) — re-list drafts to confirm.',
        );
      }
      const data = await client.createEvent({
        title: args.title,
        startDatetime: args.start_datetime,
        templateName: args.template_name,
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
        'confirm:true this returns a dry-run preview and sends nothing.',
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
