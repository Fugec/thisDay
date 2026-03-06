/**
 * Cloudflare R2 — upload and download helpers.
 *
 * R2 is S3-compatible, so we use @aws-sdk/client-s3 with a custom endpoint.
 *
 * Required env vars:
 *   CF_ACCOUNT_ID        — your Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — R2 API token (Cloudflare dashboard → R2 → Manage API tokens)
 *   R2_SECRET_ACCESS_KEY — R2 API secret
 *   R2_BUCKET_NAME       — bucket name (e.g. "thisday-videos")
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function getClient() {
  const accountId = process.env.CF_ACCOUNT_ID;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

const bucket = () => process.env.R2_BUCKET_NAME;

/**
 * Uploads a local video file to R2 as `{slug}.mp4`.
 *
 * @param {string} slug       - Post slug used as the object key
 * @param {string} videoPath  - Local path to the MP4 file
 */
export async function uploadToR2(slug, videoPath) {
  const client = getClient();
  const key = `${slug}.mp4`;

  await client.send(new PutObjectCommand({
    Bucket:      bucket(),
    Key:         key,
    Body:        createReadStream(videoPath),
    ContentType: 'video/mp4',
  }));

  console.log(`  R2: uploaded → ${key}`);
}

/**
 * Downloads `{slug}.mp4` from R2 to a temp file and returns the local path.
 *
 * @param {string} slug
 * @returns {Promise<string>} local path to the downloaded MP4
 */
export async function downloadFromR2(slug) {
  const client = getClient();
  const key    = `${slug}.mp4`;
  const dest   = join(tmpdir(), key);

  const res = await client.send(new GetObjectCommand({
    Bucket: bucket(),
    Key:    key,
  }));

  await pipeline(res.Body, createWriteStream(dest));
  console.log(`  R2: downloaded → ${dest}`);
  return dest;
}
