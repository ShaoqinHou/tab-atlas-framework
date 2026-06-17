export interface WebPageMetadataArtifact {
  url: string;
  status: 'not_started' | 'complete' | 'failed_network' | 'failed_parse' | 'blocked_auth_required';
  title?: string;
  description?: string;
  contentType?: string;
  textExcerpt?: string;
  provenance: 'public_http' | 'extension_snapshot';
}

export async function fetchWebPageMetadata(url: string, timeoutMs = 10_000): Promise<WebPageMetadataArtifact> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'TabAtlas/0.1 local metadata fetcher' },
      redirect: 'follow',
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status === 401 || res.status === 403) return { url, status: 'blocked_auth_required', contentType, provenance: 'public_http' };
    const text = await res.text();
    return {
      url,
      status: 'complete',
      contentType,
      title: matchFirst(text, /<title[^>]*>([\s\S]*?)<\/title>/i),
      description: matchMetaDescription(text),
      textExcerpt: stripHtml(text).slice(0, 4000),
      provenance: 'public_http',
    };
  } catch {
    return { url, status: 'failed_network', provenance: 'public_http' };
  } finally {
    clearTimeout(timeout);
  }
}

function matchFirst(text: string, re: RegExp): string | undefined {
  const m = text.match(re)?.[1]?.trim();
  return m ? decodeEntities(m) : undefined;
}

function matchMetaDescription(text: string): string | undefined {
  const m = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1]
    ?? text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i)?.[1];
  return m ? decodeEntities(m.trim()) : undefined;
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
