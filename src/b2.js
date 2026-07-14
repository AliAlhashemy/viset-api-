const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.B2_REGION || 'us-east-005';
const ENDPOINT = process.env.B2_ENDPOINT || `https://s3.${REGION}.backblazeb2.com`;
const BUCKET = process.env.B2_BUCKET_NAME;

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.B2_APPLICATION_KEY_ID || !process.env.B2_APPLICATION_KEY || !BUCKET) {
      return null;
    }
    client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: process.env.B2_APPLICATION_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
      },
      forcePathStyle: true,
    });
  }
  return client;
}

async function uploadFile(buffer, filename, mimetype) {
  const s3 = getClient();
  if (!s3) throw new Error('B2 not configured');
  const key = `viset/${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
  }));
  return { url: key, key };
}

async function deleteFile(key) {
  const s3 = getClient();
  if (!s3) return;
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function createSignedUrl(key, expiresIn = 300) {
  const s3 = getClient();
  if (!s3) throw new Error('B2 not configured');
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn });
}

module.exports = { uploadFile, deleteFile, createSignedUrl, publicUrl: (k) => k };
