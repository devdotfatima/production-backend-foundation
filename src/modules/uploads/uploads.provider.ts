import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';

export type UploadDirective = {
  method: 'PUT' | 'POST';
  url: string;
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  expiresAt: Date;
};

export type StoredObjectMetadata = {
  size: number;
  contentType?: string;
  checksum?: string;
  url?: string;
};

export type DownloadedObject = {
  body: Readable;
  contentLength?: number;
  contentType?: string;
};

export type DirectDownload = {
  url: string;
  expiresAt: Date;
};

export interface UploadProviderAdapter {
  readonly kind: 'S3' | 'CLOUDINARY';
  createUpload(input: {
    objectKey: string;
    contentType: string;
    size: number;
    visibility: 'PRIVATE' | 'PUBLIC';
  }): Promise<UploadDirective>;
  inspectObject(input: {
    objectKey: string;
    contentType: string;
    visibility?: 'PRIVATE' | 'PUBLIC';
  }): Promise<StoredObjectMetadata>;
  createDownloadUrl(input: {
    objectKey: string;
    contentType: string;
    visibility?: 'PRIVATE' | 'PUBLIC';
  }): Promise<string>;
  /** Optional because only providers with genuinely expiring signatures may bypass the API. */
  createDirectDownload?(input: {
    objectKey: string;
    contentType: string;
    filename: string;
    visibility?: 'PRIVATE' | 'PUBLIC';
    expiresInSeconds: number;
  }): Promise<DirectDownload>;
  openDownload(input: {
    objectKey: string;
    contentType: string;
    visibility?: 'PRIVATE' | 'PUBLIC';
  }): Promise<DownloadedObject>;
  readObjectPrefix(input: {
    objectKey: string;
    contentType: string;
    visibility?: 'PRIVATE' | 'PUBLIC';
    maxBytes: number;
  }): Promise<Buffer>;
  deleteObject(input: {
    objectKey: string;
    contentType: string;
    visibility?: 'PRIVATE' | 'PUBLIC';
  }): Promise<void>;
}

function optionalAwsCredentials(config: Env) {
  if (!config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY) return undefined;
  return {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    ...(config.AWS_SESSION_TOKEN ? { sessionToken: config.AWS_SESSION_TOKEN } : {}),
  };
}

export function createS3UploadProvider(config: Env): UploadProviderAdapter {
  const client = new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: optionalAwsCredentials(config),
    // The browser supplies the body after this server signs the request, so the SDK cannot
    // calculate a payload checksum here. Avoid presigning the checksum of an empty body.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const bucket = config.S3_BUCKET;

  return {
    kind: 'S3',
    async createUpload(input) {
      const expiresAt = new Date(Date.now() + config.UPLOAD_URL_TTL_SECONDS * 1_000);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
        ContentLength: input.size,
        // The same presigned URL remains valid until expiry. Make it a create-only capability so
        // bytes accepted/scanned under this key cannot be replaced with a second PUT afterwards.
        IfNoneMatch: '*',
      });
      return {
        method: 'PUT',
        url: await getSignedUrl(client, command, { expiresIn: config.UPLOAD_URL_TTL_SECONDS }),
        headers: {
          'content-type': input.contentType,
          'content-length': String(input.size),
          'if-none-match': '*',
        },
        expiresAt,
      };
    },
    async inspectObject(input) {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.objectKey }),
        { abortSignal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS) },
      );
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType?.split(';', 1)[0]?.trim().toLowerCase(),
        checksum: result.ChecksumSHA256 ?? result.ETag?.replaceAll('"', ''),
      };
    },
    async readObjectPrefix(input) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: input.objectKey,
          Range: `bytes=0-${Math.max(0, input.maxBytes - 1)}`,
        }),
        { abortSignal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS) },
      );
      if (!result.Body) throw errors.notFound('Uploaded object is unavailable');
      const bytes = Buffer.from(await result.Body.transformToByteArray());
      return bytes.subarray(0, input.maxBytes);
    },
    createDownloadUrl(input) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: input.objectKey }), {
        expiresIn: config.UPLOAD_URL_TTL_SECONDS,
      });
    },
    async createDirectDownload(input) {
      const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000);
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`;
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: input.objectKey,
          ResponseContentType: input.contentType,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return { url, expiresAt };
    },
    async openDownload(input) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: input.objectKey }),
        { abortSignal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS) },
      );
      if (!result.Body) throw errors.notFound('Uploaded object is unavailable');
      return {
        body: result.Body as unknown as Readable,
        contentLength: result.ContentLength,
        contentType: result.ContentType?.split(';', 1)[0]?.trim().toLowerCase(),
      };
    },
    async deleteObject(input) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: input.objectKey }), {
        abortSignal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS),
      });
    },
  };
}

function cloudinaryResourceType(contentType: string): 'image' | 'raw' {
  return contentType.startsWith('image/') ? 'image' : 'raw';
}

function cloudinarySignature(
  parameters: Record<string, string | number | boolean>,
  secret: string,
): string {
  const canonical = Object.entries(parameters)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
  return createHash('sha1').update(`${canonical}${secret}`).digest('hex');
}

function signedCloudinaryDeliveryUrl(value: string, secret: string): string {
  const url = new URL(value);
  const marker = '/authenticated/';
  const index = url.pathname.indexOf(marker);
  if (index < 0) return value;
  const suffix = url.pathname.slice(index + marker.length);
  const signature = createHash('sha1').update(`${suffix}${secret}`).digest('base64url').slice(0, 8);
  url.pathname = `${url.pathname.slice(0, index + marker.length)}s--${signature}--/${suffix}`;
  return url.toString();
}

async function cloudinaryJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const nested = value.error;
    const message =
      nested &&
      typeof nested === 'object' &&
      typeof (nested as { message?: unknown }).message === 'string'
        ? (nested as { message: string }).message
        : 'Cloudinary request failed';
    throw errors.serviceUnavailable(message);
  }
  return value;
}

export function createCloudinaryUploadProvider(config: Env): UploadProviderAdapter {
  const cloudName = config.CLOUDINARY_CLOUD_NAME;
  const apiKey = config.CLOUDINARY_API_KEY;
  const apiSecret = config.CLOUDINARY_API_SECRET;
  const basicAuthorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;

  return {
    kind: 'CLOUDINARY',
    async createUpload(input) {
      const timestamp = Math.floor(Date.now() / 1_000);
      const expiresAt = new Date((timestamp + config.UPLOAD_URL_TTL_SECONDS) * 1_000);
      const signed = {
        public_id: input.objectKey,
        timestamp,
        overwrite: false,
        unique_filename: false,
        type: 'authenticated',
      } as const;
      const resourceType = cloudinaryResourceType(input.contentType);
      return {
        method: 'POST',
        url: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
        fields: {
          api_key: apiKey,
          public_id: input.objectKey,
          timestamp: String(timestamp),
          overwrite: 'false',
          unique_filename: 'false',
          type: signed.type,
          signature: cloudinarySignature(signed, apiSecret),
        },
        expiresAt,
      };
    },
    async inspectObject(input) {
      const resourceType = cloudinaryResourceType(input.contentType);
      const deliveryType = 'authenticated';
      const url = `https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/${deliveryType}/${encodeURIComponent(input.objectKey)}`;
      const value = await cloudinaryJson(url, {
        method: 'GET',
        headers: { authorization: basicAuthorization },
        signal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS),
      });
      return {
        size: typeof value.bytes === 'number' ? value.bytes : 0,
        checksum: typeof value.etag === 'string' ? value.etag : undefined,
        url: typeof value.secure_url === 'string' ? value.secure_url : undefined,
      };
    },
    async createDownloadUrl(input) {
      const metadata = await this.inspectObject(input);
      if (!metadata.url) throw errors.serviceUnavailable('Cloudinary asset URL is unavailable');
      return signedCloudinaryDeliveryUrl(metadata.url, apiSecret);
    },
    async openDownload(input) {
      const metadata = await this.inspectObject(input);
      if (!metadata.url) throw errors.notFound('Uploaded object is unavailable');
      const response = await fetch(signedCloudinaryDeliveryUrl(metadata.url, apiSecret), {
        signal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        throw errors.serviceUnavailable('Unable to read uploaded object');
      }
      return {
        body: Readable.fromWeb(response.body),
        contentLength: Number(response.headers.get('content-length') ?? metadata.size) || undefined,
        contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase(),
      };
    },
    async readObjectPrefix(input) {
      const metadata = await this.inspectObject(input);
      if (!metadata.url) throw errors.notFound('Uploaded object is unavailable');
      const response = await fetch(signedCloudinaryDeliveryUrl(metadata.url, apiSecret), {
        headers: { range: `bytes=0-${Math.max(0, input.maxBytes - 1)}` },
        signal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok) throw errors.serviceUnavailable('Unable to read quarantined upload');
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.subarray(0, input.maxBytes);
    },
    async deleteObject(input) {
      const timestamp = Math.floor(Date.now() / 1_000);
      const resourceType = cloudinaryResourceType(input.contentType);
      const signed = {
        public_id: input.objectKey,
        timestamp,
        type: 'authenticated',
      };
      const form = new URLSearchParams({
        public_id: input.objectKey,
        timestamp: String(timestamp),
        api_key: apiKey,
        type: signed.type,
        signature: cloudinarySignature(signed, apiSecret),
      });
      await cloudinaryJson(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(config.UPLOAD_PROVIDER_TIMEOUT_MS),
      });
    },
  };
}

export function createUploadProvider(config: Env): UploadProviderAdapter | null {
  if (config.UPLOAD_PROVIDER === 's3') return createS3UploadProvider(config);
  if (config.UPLOAD_PROVIDER === 'cloudinary') return createCloudinaryUploadProvider(config);
  return null;
}
