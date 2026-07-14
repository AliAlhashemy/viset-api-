const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.B2_REGION || 'us-west-001';
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

function publicUrl(key) {
  const base = process.env.B2_PUBLIC_URL || `https://${BUCKET}.s3.${REGION}.backblazeb2.com`;
  return `${base}/${key}`;
}

async function uploadFile(buffer, filename, mimetype) {
  const s3 = getClient();
  if (!s3) throw new Error('B2 not configured — set B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME');
  const key = `viset/${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
  }));
  return { url: publicUrl(key), key };
}

async function deleteFile(key) {
  const s3 = getClient();
  if (!s3) return;
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadFile, deleteFile, publicUrl };
