import { describe, expect, it } from 'vitest';
import { createS3UploadProvider } from '../dist/src/modules/uploads/uploads.provider.js';

function queryParameter(url: URL, name: string): string | null {
  const found = [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

describe('S3 upload provider', () => {
  it('presigns a create-only PUT and requires the client to send If-None-Match', async () => {
    const provider = createS3UploadProvider({
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: 'https://s3.example.test',
      S3_FORCE_PATH_STYLE: true,
      S3_BUCKET: 'uploads',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_SESSION_TOKEN: '',
      UPLOAD_URL_TTL_SECONDS: 600,
    } as never);

    const directive = await provider.createUpload({
      objectKey: 'user/2026/08/immutable-object',
      contentType: 'image/png',
      size: 100,
      visibility: 'PRIVATE',
    });

    const url = new URL(directive.url);
    const signedHeaders = queryParameter(url, 'X-Amz-SignedHeaders')?.split(';') ?? [];
    expect(directive).toMatchObject({
      method: 'PUT',
      headers: {
        'content-type': 'image/png',
        'content-length': '100',
        'if-none-match': '*',
      },
    });
    expect(signedHeaders).toContain('if-none-match');
    expect(queryParameter(url, 'x-amz-checksum-crc32')).toBeNull();
  });
});
