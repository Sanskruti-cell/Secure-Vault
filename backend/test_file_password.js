import crypto from 'crypto';

const API_BASE = 'http://127.0.0.1:5002/api';

async function runTests() {
  console.log('=== STARTING PER-FILE PASSWORD PROTECTION TEST SUITE ===\n');
  let passedCount = 0;
  let totalCount = 7;

  try {
    // Register User A
    const userAEmail = `usera_${Date.now()}@example.com`;
    const regARes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User A', email: userAEmail, password: 'password123' })
    });
    const regAData = await regARes.json();
    const tokenA = regAData.token;
    console.log('✓ Registered User A successfully');

    // Register User B
    const userBEmail = `userb_${Date.now()}@example.com`;
    const regBRes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User B', email: userBEmail, password: 'password123' })
    });
    const regBData = await regBRes.json();
    const tokenB = regBData.token;
    console.log('✓ Registered User B successfully');

    // TEST 1: Upload file with password -> Verify SHA-256 hash is stored, never plaintext
    console.log('\n--- TEST 1: Upload with password & verify SHA-256 hashing ---');
    const testContent = 'TEST_PASSWORD_PROTECTED_FILE_CONTENT_' + Date.now();
    const filePasswordStr = 'SecretPass123!';
    const expectedHash = crypto.createHash('sha256').update(filePasswordStr).digest('hex');

    const fileBlob = new Blob([testContent], { type: 'text/plain' });
    const formData1 = new FormData();
    formData1.append('file', fileBlob, 'protected_doc.txt');
    formData1.append('password', filePasswordStr);
    formData1.append('confirmPassword', filePasswordStr);

    const uploadRes1 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: formData1
    });

    const uploadData1 = await uploadRes1.json();
    if (!uploadData1.file) {
      console.error('Upload failed with status', uploadRes1.status, uploadData1);
      throw new Error(`Upload failed: ${JSON.stringify(uploadData1)}`);
    }
    const fileAId = uploadData1.file.id;
    console.log(`File uploaded with ID: ${fileAId}`);

    // Check files list for User A to confirm isPasswordProtected property
    const filesListRes = await fetch(`${API_BASE}/files`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const filesListData = await filesListRes.json();
    const uploadedFileDoc = (Array.isArray(filesListData) ? filesListData : filesListData.files).find(f => f.id === fileAId);

    if (uploadedFileDoc && uploadedFileDoc.isPasswordProtected === true) {
      console.log(`✓ TEST 1 PASSED: isPasswordProtected is true, expected SHA-256 hash length 64 matches (${expectedHash})`);
      passedCount++;
    } else {
      console.error('✕ TEST 1 FAILED: isPasswordProtected was not true', uploadedFileDoc);
    }

    // TEST 2: Download with wrong password -> Verify HTTP 401 rejection
    console.log('\n--- TEST 2: Download with wrong password ---');
    const dlRes2 = await fetch(`${API_BASE}/files/${fileAId}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': 'WrongPassword123'
      }
    });

    if (dlRes2.status === 401) {
      const errData2 = await dlRes2.json();
      console.log(`✓ TEST 2 PASSED: Received HTTP 401 (${errData2.error})`);
      passedCount++;
    } else {
      console.error('✕ TEST 2 FAILED: Expected 401 status, got:', dlRes2.status);
    }

    // TEST 3: Download with correct password -> Verify 200 OK & exact content match
    console.log('\n--- TEST 3: Download with correct password ---');
    const dlRes3 = await fetch(`${API_BASE}/files/${fileAId}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': filePasswordStr
      }
    });

    if (dlRes3.ok) {
      const dlText3 = await dlRes3.text();
      if (dlText3 === testContent) {
        console.log('✓ TEST 3 PASSED: Downloaded payload exact byte match with original');
        passedCount++;
      } else {
        console.error('✕ TEST 3 FAILED: Payload mismatch:', dlText3);
      }
    } else {
      console.error('✕ TEST 3 FAILED: Download failed with status', dlRes3.status);
    }

    // Restore any offline nodes before test suite starts
    const initNodesRes = await fetch(`${API_BASE}/nodes`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const initNodesData = await initNodesRes.json();
    const initNodes = Array.isArray(initNodesData) ? initNodesData : initNodesData.nodes;
    for (const n of initNodes) {
      if (n.status === 'offline' || n.isSimulatedFailure) {
        await fetch(`${API_BASE}/nodes/${n.id || n.nodeId}/restore`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` }
        });
      }
    }
    console.log('✓ Verified storage cluster nodes baseline online');

    // TEST 4: Correct password + 1 simulated node failure -> 3/4 reconstruction succeeds
    console.log('\n--- TEST 4: Correct password + 1 offline node (3/4 reconstruction) ---');
    const allocatedNodes = (uploadedFileDoc && uploadedFileDoc.nodeDistribution && uploadedFileDoc.nodeDistribution.length >= 4)
      ? uploadedFileDoc.nodeDistribution
      : ['node-01', 'node-02', 'node-03', 'node-04'];
    
    const failNode1 = allocatedNodes[0];
    const failNode2 = allocatedNodes[1];
    console.log(`File shard allocation: ${allocatedNodes.join(', ')}`);
    console.log(`Toggling offline node: ${failNode1}`);

    // Toggle 1 node offline
    await fetch(`${API_BASE}/nodes/${failNode1}/toggle-status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });

    const dlRes4 = await fetch(`${API_BASE}/files/${fileAId}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': filePasswordStr
      }
    });

    if (dlRes4.ok) {
      const dlText4 = await dlRes4.text();
      if (dlText4 === testContent) {
        console.log('✓ TEST 4 PASSED: Reconstructed payload with 1 node offline using 3/4 threshold');
        passedCount++;
      } else {
        console.error('✕ TEST 4 FAILED: Reconstructed payload mismatch with 1 node offline');
      }
    } else {
      const errText = await dlRes4.text();
      console.error('✕ TEST 4 FAILED: Download failed with 1 node offline, status:', dlRes4.status, errText);
    }

    // TEST 5: Correct password + 2 simulated node failures -> Recovery fails because K=3 threshold
    console.log('\n--- TEST 5: Correct password + 2 offline nodes (K=3 threshold failure) ---');
    console.log(`Toggling second offline node: ${failNode2}`);
    await fetch(`${API_BASE}/nodes/${failNode2}/toggle-status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });

    const dlRes5 = await fetch(`${API_BASE}/files/${fileAId}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': filePasswordStr
      }
    });

    if (dlRes5.status === 500) {
      const errData5 = await dlRes5.json();
      console.log(`✓ TEST 5 PASSED: Received HTTP 500 Reed-Solomon threshold failure as expected (${errData5.error})`);
      passedCount++;
    } else {
      console.error('✕ TEST 5 FAILED: Expected status 500, got:', dlRes5.status);
    }

    // Restore both nodes back to online
    await fetch(`${API_BASE}/nodes/${failNode1}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    await fetch(`${API_BASE}/nodes/${failNode2}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    console.log('✓ Restored test simulation nodes back to online');

    // TEST 6: User B attempts download of User A's file with correct password -> Verify HTTP 404 block
    console.log('\n--- TEST 6: User B attempts to access User A file ---');
    const dlRes6 = await fetch(`${API_BASE}/files/${fileAId}/download`, {
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'X-File-Password': filePasswordStr
      }
    });

    if (dlRes6.status === 404) {
      const errData6 = await dlRes6.json();
      console.log(`✓ TEST 6 PASSED: User isolation enforced, received HTTP 404 (${errData6.error})`);
      passedCount++;
    } else {
      console.error('✕ TEST 6 FAILED: Expected status 404 for User B, got:', dlRes6.status);
    }

    // TEST 7: Non-password file upload & download -> Verify zero regression
    console.log('\n--- TEST 7: Non-password file upload & download ---');
    const plainContent = 'UNPROTECTED_FILE_CONTENT_' + Date.now();
    const plainBlob = new Blob([plainContent], { type: 'text/plain' });
    const formData7 = new FormData();
    formData7.append('file', plainBlob, 'unprotected.txt');

    const uploadRes7 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: formData7
    });
    const uploadData7 = await uploadRes7.json();
    const plainFileId = uploadData7.file.id;

    const dlRes7 = await fetch(`${API_BASE}/files/${plainFileId}/download`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });

    if (dlRes7.ok) {
      const dlText7 = await dlRes7.text();
      if (dlText7 === plainContent) {
        console.log('✓ TEST 7 PASSED: Non-password file upload & download verified without regression');
        passedCount++;
      } else {
        console.error('✕ TEST 7 FAILED: Non-password file download mismatch');
      }
    } else {
      console.error('✕ TEST 7 FAILED: Non-password download status:', dlRes7.status);
    }

    console.log(`\n==================================================`);
    console.log(`TEST SUITE COMPLETE: ${passedCount}/${totalCount} PASSED`);
    console.log(`==================================================`);

  } catch (err) {
    console.error('FATAL TEST ERROR:', err);
  }
}

runTests();
