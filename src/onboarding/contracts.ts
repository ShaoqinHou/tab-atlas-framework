import { z } from 'zod';

export const ONBOARDING_STEPS = [
  'receiver_running',
  'dashboard_session_ready',
  'capture_roots_configured',
  'browsers_paired',
  'snapshot_captured',
  'extraction_ready',
  'codex_ready',
  'first_review_completed',
  'first_view_created',
] as const;

export const OnboardingStepId = z.enum(ONBOARDING_STEPS);
export type OnboardingStepId = z.infer<typeof OnboardingStepId>;

export const OnboardingStep = z.object({
  id: OnboardingStepId,
  title: z.string(),
  status: z.enum(['pending', 'ready', 'completed']),
  completedAt: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingSnapshot = z.object({
  steps: z.array(OnboardingStep),
  nextStepId: OnboardingStepId.optional(),
  recoveryAvailable: z.boolean().default(false),
});
export type OnboardingSnapshot = z.infer<typeof OnboardingSnapshot>;

export const ONBOARDING_STEP_TITLES: Record<OnboardingStepId, string> = {
  receiver_running: 'Receiver running',
  dashboard_session_ready: 'Dashboard session ready',
  capture_roots_configured: 'Capture roots configured',
  browsers_paired: 'Chrome and Edge paired',
  snapshot_captured: 'Snapshot captured',
  extraction_ready: 'Extraction ready',
  codex_ready: 'Codex ready',
  first_review_completed: 'First review completed',
  first_view_created: 'First view created',
};
