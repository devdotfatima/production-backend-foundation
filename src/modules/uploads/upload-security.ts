import { env } from '#app/config/env.js';

const signatures: Array<{ mime: string; matches: (bytes: Buffer) => boolean }> = [
  {
    mime: 'image/jpeg',
    matches: (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
  {
    mime: 'image/png',
    matches: (bytes) =>
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    matches: (bytes) =>
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mime: 'application/pdf',
    matches: (bytes) => bytes.subarray(0, 5).toString('ascii') === '%PDF-',
  },
];

export function detectContentType(bytes: Buffer): string | null {
  return signatures.find((signature) => signature.matches(bytes))?.mime ?? null;
}

export function requiresDocumentCdr(contentType: string): boolean {
  return (
    contentType === 'application/pdf' ||
    contentType.includes('word') ||
    contentType.includes('officedocument')
  );
}

export async function scanUpload(input: {
  uploadId: string;
  filename: string;
  contentType: string;
  size: number;
  checksum?: string;
  sourceUrl: string;
}): Promise<{ verdict: 'CLEAN' | 'MALICIOUS'; provider: string; reference?: string }> {
  if (env.UPLOAD_SCAN_MODE === 'disabled') {
    return { verdict: 'CLEAN', provider: 'signature-only' };
  }
  const response = await fetch(env.UPLOAD_SCAN_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.UPLOAD_SCAN_WEBHOOK_AUTH_TOKEN
        ? { authorization: `Bearer ${env.UPLOAD_SCAN_WEBHOOK_AUTH_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      uploadId: input.uploadId,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      checksum: input.checksum,
      sourceUrl: input.sourceUrl,
      cdrRequired: requiresDocumentCdr(input.contentType),
    }),
    signal: AbortSignal.timeout(env.UPLOAD_SCAN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Upload scanner returned HTTP ${response.status}`);
  const result = (await response.json()) as { verdict?: unknown; reference?: unknown };
  if (result.verdict !== 'CLEAN' && result.verdict !== 'MALICIOUS') {
    throw new Error('Upload scanner returned an invalid verdict');
  }
  return {
    verdict: result.verdict,
    provider: 'webhook',
    ...(typeof result.reference === 'string' ? { reference: result.reference } : {}),
  };
}
