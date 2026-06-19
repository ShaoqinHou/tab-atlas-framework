import { z } from 'zod';

export const ReviewSessionType = z.enum([
  'unmarked',
  'ambiguous',
  'ambiguous_command',
  'weak_matches',
  'conflicts',
  'extraction_failures',
]);
export type ReviewSessionType = z.infer<typeof ReviewSessionType>;

export const REVIEW_KEYBOARD_SHORTCUTS = {
  save: 'Enter',
  skip: 'S',
  ignore: 'I',
  important: '1',
  watchLater: '2',
  projectReference: '3',
  inspiration: '4',
  pause: 'P',
} as const;

export const ReviewSessionCreateInput = z.object({
  type: ReviewSessionType.default('unmarked'),
  title: z.string().optional(),
  commandText: z.string().optional(),
  sourceViewId: z.string().optional(),
  explicitResourceIds: z.array(z.string()).optional(),
  resourceIds: z.array(z.string()).optional(),
  preload: z.number().int().positive().max(20).default(4),
});
export type ReviewSessionCreateInput = z.input<typeof ReviewSessionCreateInput>;

export const ReviewSessionDecisionInput = z.object({
  resourceId: z.string(),
  action: z.enum(['save_and_next', 'skip', 'mark_ignore']),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  decision: z.enum([
    'important',
    'watch_later',
    'project_reference',
    'inspiration',
    'archive_later',
    'ignore',
    'needs_deeper_read',
    'none',
  ]).default('none'),
});
export type ReviewSessionDecisionInput = z.input<typeof ReviewSessionDecisionInput>;
