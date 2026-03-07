/**
 * Cloudflare R2 — list uploaded video slugs.
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Returns an array of slugs currently in the R2 bucket (strips .mp4 extension).
 *
 * @returns {Promise<string[]>}
 */
export async function listR2Slugs() {
  const client = getClient();
  const slugs  = [];
  let token;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket:            process.env.R2_BUCKET_NAME,
      ContinuationToken: token,
    }));

    for (const obj of res.Contents ?? []) {
      if (obj.Key.endsWith('.mp4')) {
        slugs.push(obj.Key.replace(/\.mp4$/, ''));
      }
    }

    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return slugs;
}
