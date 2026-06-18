import type { ResourceBrief } from '../shared/schemas.js';

export const PROMPT_REDACTION_VERSION = 'prompt-redaction-v1';

export function redactUrlForPrompt(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.hash = '';
    if (isYouTubeHost(url.hostname)) {
      const videoId = url.searchParams.get('v');
      url.search = '';
      if (videoId) url.searchParams.set('v', videoId);
    } else {
      url.search = '';
    }
    return url.toString();
  } catch {
    return redactSensitiveText(rawUrl);
  }
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|signature|x-amz-signature)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_SECRET]')
    .replace(/\bhttps?:\/\/[^\s<>)"']+/gi, match => redactUrlForPrompt(match));
}

export function projectResourceBriefForPrompt(brief: ResourceBrief): ResourceBrief {
  return {
    ...brief,
    canonicalUrl: redactUrlForPrompt(brief.canonicalUrl),
    redactedUrl: brief.redactedUrl ? redactUrlForPrompt(brief.redactedUrl) : undefined,
    title: brief.title ? redactSensitiveText(brief.title) : undefined,
    browserGroupTitles: brief.browserGroupTitles.map(redactSensitiveText),
    userAnnotations: brief.userAnnotations.map(annotation => ({
      ...annotation,
      tags: annotation.tags.map(redactSensitiveText),
      description: annotation.description ? redactSensitiveText(annotation.description) : undefined,
    })),
    summary: brief.summary ? redactSensitiveText(brief.summary) : undefined,
    atomicItems: brief.atomicItems.map(item => ({
      ...item,
      name: redactSensitiveText(item.name),
      summary: item.summary ? redactSensitiveText(item.summary) : undefined,
    })),
    evidence: brief.evidence.map(evidence => ({
      ...evidence,
      text: redactSensitiveText(evidence.text),
      provenance: redactSensitiveText(evidence.provenance),
    })),
  };
}

export function projectResourceBriefsForPrompt(briefs: ResourceBrief[]): ResourceBrief[] {
  return briefs.map(projectResourceBriefForPrompt);
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
}
