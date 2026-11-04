import {
  UNTRUSTED_CONTENT_RULE,
  minifiedResult,
  resolveView,
  stripMediaUrls,
  untrustedEnvelope,
  viewParam,
  type View,
} from '@chrischall/mcp-utils';
import { z } from 'zod';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back Evite's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of Evite's fields matter and which are noise.
 *
 * Compact therefore does the one projection that needs no such knowledge: it
 * strips image and avatar URLs. That is SUBTRACTIVE, so it cannot lose a field
 * nobody knew about — the failure an invented field list would risk, where a
 * record comes back with holes in it and reads like a verified answer.
 *
 * When a real payload can be captured, a field projection belongs here beside
 * this one and will save considerably more. Until then this is the honest
 * ceiling, and this docblock says so rather than implying a shape was checked.
 */
export const EVITE_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact strips image/avatar URLs from the response; "full" returns Evite\'s payload untouched. ' +
  'No field projection: this server has no verified record of which Evite fields matter, and inventing ' +
  'one would risk dropping a field a caller needs.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(EVITE_VIEWS, { note: NOTE });

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 */
export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, EVITE_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data) : data);
}

/**
 * The `view` parameter of `evite_list_events`, the one context-group canonical
 * read: the two rungs above plus `brief`. `brief` is not one of mcp-utils'
 * `View` rungs (it is mcp-host's group-answer shape), so the enum is spelled
 * here rather than through `viewParam`.
 */
export const listEventsViewArg = () =>
  z
    .enum([...EVITE_VIEWS, 'brief'])
    .optional()
    .describe(
      `Response shape. ${NOTE} "brief" answers one line per event — title — <ISO start or "no date"> — ` +
        '<status> — inside the untrusted-data envelope as `data`, with "-- none" for no events and ' +
        '"-- more" when the page came back full.',
    );

/**
 * Answer a `view: "brief"` read: the lines as the untrusted-data envelope's
 * `data` array — `{ untrusted_content: true, note, data: string[] }`, markers
 * first, minified — because event titles are written by each event's host. A
 * line starting with `-- ` is a note (pagination, emptiness), not an item.
 */
export function briefResponse(lines: string[], whoWrote: string): ReturnType<typeof minifiedResult> {
  return minifiedResult(untrustedEnvelope(lines, { note: `${whoWrote} ${UNTRUSTED_CONTENT_RULE}` }));
}
