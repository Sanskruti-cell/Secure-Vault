import http from 'http';

const API_HOST = '127.0.0.1';
const API_PORT = 5002;

console.log('======================================================================');
console.log('RUNNING STEP 4: DOWNLOAD & RECOVERY INTEGRATION AUDIT (TESTS 1 - 6)');
console.log('======================================================================');

function request(path, method = 'GET', data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : null;
    const reqHeaders = { ...headers };
    if (payload) reqHeaders['Content-Type'] = 'application/json';
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: `/api${path}`,
      method,
      headers: reqHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: bodyBuf });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runAudit() {
  // TEST 1: Register User A and test 4/4 shards online recovery
  const emailA = `userA_step4_${Date.now()}@securevault.io`;
  const regA = await request('/auth/register', 'POST', { name: 'Step4 User A', email: emailA, password: 'UserA123!' });
  const tokenA = JSON.parse(regA.body.toString()).token;
  const hdrA = { 'Authorization': `Bearer ${tokenA}` };

  const pdfBytes = Buffer.from('%PDF-1.7\nSecureVault Step 4 Download & Recovery Visual Telemetry Verification PDF!\n%%EOF');
  const boundary = '----Step4Boundary';
  const bodyPdf = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="step4_recovery_test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  // Write multipart body manually
  const upReq = http.request({
    hostname: API_HOST,
    port: API_PORT,
    path: '/api/files/upload',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': bodyPdf.length
    }
  });

  const upResult = await new Promise((resolve) => {
    upReq.on('response', (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    upReq.write(bodyPdf);
    upReq.end();
  });

  const fileId = upResult.file.id;
  const dlA = await request(`/files/${fileId}/download`, 'GET', null, hdrA);
  if (!dlA.body.equals(pdfBytes)) throw new Error('TEST 1 FAIL: Download byte mismatch');
  console.log('[TEST 1 PASS] All Nodes Online -> 4/4 Shards -> Normal Reconstruction & Download Verified');

  // TEST 2: Simulate failure of 1 node (e.g. Shard 1 node) -> 3/4 shards retrieved, recovery succeeds, byte match
  const shardsRes = await request(`/files/${fileId}/shards`, 'GET', null, hdrA);
  const shards = JSON.parse(shardsRes.body.toString());
  const node1Id = shards[0].nodeId;

  await request(`/nodes/${node1Id}/toggle-status`, 'POST', {}, hdrA);
  const dlB = await request(`/files/${fileId}/download`, 'GET', null, hdrA);
  if (!dlB.body.equals(pdfBytes)) throw new Error('TEST 2 FAIL: 3/4 Erasure recovery byte mismatch');
  console.log(`[TEST 2 PASS] 1 Node Offline (${node1Id}) -> 3/4 Shards Retrieved -> Erasure Coding Recovered File Bytes Match? ${dlB.body.equals(pdfBytes)}`);

  // TEST 3: Restore Node -> 4/4 shards online recovery again
  await request(`/nodes/${node1Id}/restore`, 'POST', {}, hdrA);
  const dlC = await request(`/files/${fileId}/download`, 'GET', null, hdrA);
  if (!dlC.body.equals(pdfBytes)) throw new Error('TEST 3 FAIL: Restore download failed');
  console.log(`[TEST 3 PASS] Node Restored (${node1Id}) -> 4/4 Shards Online Recovery Verified`);

  // TEST 4: Simulate 2 node failures for the same file -> Reconstruction fails cleanly with 500
  const node2Id = shards[1].nodeId;
  await request(`/nodes/${node1Id}/toggle-status`, 'POST', {}, hdrA);
  await request(`/nodes/${node2Id}/toggle-status`, 'POST', {}, hdrA);

  const dlD = await request(`/files/${fileId}/download`, 'GET', null, hdrA);
  if (dlD.status !== 500) throw new Error(`TEST 4 FAIL: Expected status 500, got ${dlD.status}`);
  console.log(`[TEST 4 PASS] 2 Nodes Offline (${node1Id}, ${node2Id}) -> 2/4 Shards (< K=3) -> Reconstruction Failed Cleanly with Status 500!`);

  // Restore nodes
  await request(`/nodes/${node1Id}/restore`, 'POST', {}, hdrA);
  await request(`/nodes/${node2Id}/restore`, 'POST', {}, hdrA);

  // TEST 5: Verify auth security check before download
  const dlUnauth = await request(`/files/${fileId}/download`, 'GET');
  if (dlUnauth.status !== 401) throw new Error(`TEST 5 FAIL: Expected status 401, got ${dlUnauth.status}`);
  console.log('[TEST 5 PASS] Unauthenticated Download Request Blocked with 401 Unauthorized!');

  // TEST 6: Multi-User Isolation (User B cannot see User A's file or shards)
  const emailB = `userB_step4_${Date.now()}@securevault.io`;
  const regB = await request('/auth/register', 'POST', { name: 'Step4 User B', email: emailB, password: 'UserB123!' });
  const tokenB = JSON.parse(regB.body.toString()).token;
  const hdrB = { 'Authorization': `Bearer ${tokenB}` };

  const dlUserB = await request(`/files/${fileId}/download`, 'GET', null, hdrB);
  if (dlUserB.status !== 404) throw new Error(`TEST 6 FAIL: Expected status 404 for User B, got ${dlUserB.status}`);
  console.log('[TEST 6 PASS] Multi-User Isolation Verified -> User B Request for User A File Blocked with 404 Not Found!');

  console.log('======================================================================');
  console.log('ALL STEP 4 UI & TELEMETRY INTEGRATION TESTS (1 - 6) PASSED 100% PERFECTLY!');
  console.log('======================================================================');
}

runAudit().catch(err => {
  console.error('Audit Error:', err);
  process.exit(1);
});
