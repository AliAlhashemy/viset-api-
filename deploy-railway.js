const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOKEN = process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN || '';
const API = 'https://backboard.railway.app/graphql/v2';

function gql(query, vars = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables: vars });
    const opts = {
      hostname: 'backboard.railway.app', path: '/graphql/v2',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // 1. Get project and service info
  const projectId = 'bf1359fc-042c-47f0-8cbe-1ac65b977fb1';
  const serviceId = '056bb1a8-3904-42f5-9571-986cccb13e47';
  const environmentId = '76574043-a393-45c2-8d07-4c3ecb14f4e7';

  console.log('Creating tarball...');
  execSync('tar -czf ../deploy.tar.gz --exclude=node_modules --exclude=.env .', {
    cwd: __dirname, stdio: 'pipe'
  });

  const tarball = fs.readFileSync(path.join(__dirname, '..', 'deploy.tar.gz'));
  console.log(`Tarball size: ${(tarball.length / 1024 / 1024).toFixed(2)} MB`);

  // 2. Create upload source
  console.log('Creating upload source...');
  const srcResult = await gql(`
    mutation CreateSource($projectId: String!) {
      createCommandSource(projectId: $projectId) {
        uploadUrl
        sourceId
        projectId
      }
    }
  `, { projectId });

  console.log('Source result:', JSON.stringify(srcResult, null, 2));
  if (srcResult.errors) {
    throw new Error('GraphQL errors: ' + JSON.stringify(srcResult.errors));
  }
  if (!srcResult.data || !srcResult.data.createCommandSource) {
    throw new Error('Unexpected response structure - no createCommandSource in data');
  }
  const { uploadUrl, sourceId } = srcResult.data.createCommandSource;
  console.log(`Upload URL: ${uploadUrl.slice(0, 50)}...`);
  console.log(`Source ID: ${sourceId}`);

  // 3. Upload tarball
  console.log('Uploading tarball...');
  await new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const opts = {
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/gzip', 'Content-Length': tarball.length }
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { console.log('Upload response:', d); resolve(); });
    });
    req.on('error', reject);
    req.write(tarball);
    req.end();
  });

  // 4. Create deployment
  console.log('Creating deployment...');
  const deployResult = await gql(`
    mutation CreateDeployment($input: DeploymentCreateInput!) {
      deploymentCreate(input: $input) {
        id
        status
        url
      }
    }
  `, {
    input: {
      projectId,
      serviceId,
      environmentId,
      sourceId,
      sourceType: "COMMAND",
    }
  });

  console.log('Deployment created:', JSON.stringify(deployResult.data.deploymentCreate, null, 2));

  // Cleanup
  fs.unlinkSync(path.join(__dirname, '..', 'deploy.tar.gz'));
  console.log('Done!');
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
