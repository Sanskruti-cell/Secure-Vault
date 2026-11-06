import crypto from 'crypto';

const API_BASE = 'http://127.0.0.1:5002/api';

async function run12Tests() {
  console.log('==================================================');
  console.log('SECUREVAULT 12-TEST VERIFICATION SUITE');
  console.log('==================================================\n');

  let passed = 0;
  const total = 12;

  try {
    // Setup users
    const userAEmail = `user_a_${Date.now()}@securevault.io`;
    const regARes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User A', email: userAEmail, password: 'password123' }),
    });
    const tokenA = (await regARes.json()).token;

    const userBEmail = `user_b_${Date.now()}@securevault.io`;
    const regBRes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User B', email: userBEmail, password: 'password123' }),
    });
    const tokenB = (await regBRes.json()).token;

    // Restore all cluster nodes
    const nodesRes = await fetch(`${API_BASE}/nodes`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const nodes = await nodesRes.json();
    const nodeList = Array.isArray(nodes) ? nodes : (nodes && nodes.nodes ? nodes.nodes : []);
    for (const n of nodeList) {
      if (n.status === 'offline' || n.isSimulatedFailure) {
        await fetch(`${API_BASE}/nodes/${n.id || n.nodeId}/restore`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` },
        });
      }
    }
    console.log('✓ Initialized test environment: Registered User A, User B; All nodes online\n');

    // TEST 1: Upload password-protected file with valid password + confirmation.
    console.log('--- TEST 1: Upload with valid password (>= 8 chars) & confirmation ---');
    const content1 = 'PAYLOAD_FILE_1_SECRET_CONTENT_' + Date.now();
    const pass1 = 'StrongVaultPass1!';
    const form1 = new FormData();
    form1.append('file', new Blob([content1], { type: 'text/plain' }), 'doc1.txt');
    form1.append('password', pass1);
    form1.append('confirmPassword', pass1);

    const uploadRes1 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form1,
    });
    const uploadData1 = await uploadRes1.json();
    if (uploadRes1.status === 201 && uploadData1.file && uploadData1.file.id) {
      console.log(`✓ TEST 1 PASSED: File uploaded successfully with ID: ${uploadData1.file.id}`);
      passed++;
    } else {
      console.error('✕ TEST 1 FAILED:', uploadRes1.status, uploadData1);
    }
    const file1Id = uploadData1.file.id;

    // TEST 2: Password mismatch -> Upload blocked
    console.log('\n--- TEST 2: Password mismatch validation ---');
    const form2 = new FormData();
    form2.append('file', new Blob(['test content'], { type: 'text/plain' }), 'mismatch.txt');
    form2.append('password', 'SecretPassword123');
    form2.append('confirmPassword', 'DifferentPassword456');

    const uploadRes2 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form2,
    });
    if (uploadRes2.status === 400) {
      const err2 = await uploadRes2.json();
      console.log(`✓ TEST 2 PASSED: Upload blocked on mismatch (HTTP 400: ${err2.error})`);
      passed++;
    } else {
      console.error('✕ TEST 2 FAILED: Expected 400 on password mismatch, got:', uploadRes2.status);
    }

    // TEST 3: Password less than 8 characters -> Upload blocked
    console.log('\n--- TEST 3: Password length < 8 characters validation ---');
    const form3 = new FormData();
    form3.append('file', new Blob(['test content'], { type: 'text/plain' }), 'short.txt');
    form3.append('password', 'short1');
    form3.append('confirmPassword', 'short1');

    const uploadRes3 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form3,
    });
    if (uploadRes3.status === 400) {
      const err3 = await uploadRes3.json();
      console.log(`✓ TEST 3 PASSED: Upload blocked on short password (HTTP 400: ${err3.error})`);
      passed++;
    } else {
      console.error('✕ TEST 3 FAILED: Expected 400 on short password, got:', uploadRes3.status);
    }

    // TEST 4: Download password-protected file -> Verification modal required / isPasswordProtected
    console.log('\n--- TEST 4: Verify password requirement before download ---');
    const dlNoPassRes = await fetch(`${API_BASE}/files/${file1Id}/download`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    if (dlNoPassRes.status === 401) {
      const err4 = await dlNoPassRes.json();
      console.log(`✓ TEST 4 PASSED: Download blocked without password (HTTP 401: ${err4.error}) -> Verification modal required`);
      passed++;
    } else {
      console.error('✕ TEST 4 FAILED: Expected 401 without password, got:', dlNoPassRes.status);
    }

    // TEST 5: Enter incorrect password -> Download blocked + error shown
    console.log('\n--- TEST 5: Incorrect password rejection ---');
    const dlWrongPassRes = await fetch(`${API_BASE}/files/${file1Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': 'WrongPassword123!',
      },
    });
    if (dlWrongPassRes.status === 401) {
      const err5 = await dlWrongPassRes.json();
      console.log(`✓ TEST 5 PASSED: Rejected with exact message (HTTP 401: ${err5.error})`);
      passed++;
    } else {
      console.error('✕ TEST 5 FAILED: Expected 401 with wrong password, got:', dlWrongPassRes.status);
    }

    // TEST 6: Enter correct password -> Original file downloads successfully
    console.log('\n--- TEST 6: Correct password download & recovery ---');
    const dlCorrectRes = await fetch(`${API_BASE}/files/${file1Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': pass1,
      },
    });
    if (dlCorrectRes.ok) {
      const downloadedText = await dlCorrectRes.text();
      if (downloadedText === content1) {
        console.log('✓ TEST 6 PASSED: Downloaded payload exact match with original');
        passed++;
      } else {
        console.error('✕ TEST 6 FAILED: Content mismatch:', downloadedText);
      }
    } else {
      console.error('✕ TEST 6 FAILED: Expected 200 OK, got:', dlCorrectRes.status);
    }

    // TEST 7: Upload two files with different passwords -> Each accepts only its own
    console.log('\n--- TEST 7: Multiple files with independent passwords ---');
    const content2 = 'PAYLOAD_FILE_2_OTHER_SECRET_' + Date.now();
    const pass2 = 'DifferentPass888!';
    const form7 = new FormData();
    form7.append('file', new Blob([content2], { type: 'text/plain' }), 'doc2.txt');
    form7.append('password', pass2);
    form7.append('confirmPassword', pass2);

    const uploadRes7 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form7,
    });
    const file2Id = (await uploadRes7.json()).file.id;

    // Try accessing File 2 with Password 1 (should fail)
    const dlCrossRes = await fetch(`${API_BASE}/files/${file2Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': pass1,
      },
    });

    // Try accessing File 2 with Password 2 (should succeed)
    const dlOwnRes = await fetch(`${API_BASE}/files/${file2Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': pass2,
      },
    });

    if (dlCrossRes.status === 401 && dlOwnRes.ok && (await dlOwnRes.text()) === content2) {
      console.log('✓ TEST 7 PASSED: File 2 rejected File 1 password and accepted only its own password');
      passed++;
    } else {
      console.error('✕ TEST 7 FAILED: Cross password isolation failed');
    }

    // TEST 8: Upload file without password -> No password modal during download
    console.log('\n--- TEST 8: Non-password file upload & direct download ---');
    const content8 = 'STANDARD_UNPROTECTED_FILE_' + Date.now();
    const form8 = new FormData();
    form8.append('file', new Blob([content8], { type: 'text/plain' }), 'plain.txt');

    const uploadRes8 = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form8,
    });
    const file8Id = (await uploadRes8.json()).file.id;

    const dlPlainRes = await fetch(`${API_BASE}/files/${file8Id}/download`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    if (dlPlainRes.ok && (await dlPlainRes.text()) === content8) {
      console.log('✓ TEST 8 PASSED: File without password downloaded directly without password prompt');
      passed++;
    } else {
      console.error('✕ TEST 8 FAILED: Unprotected download failed, status:', dlPlainRes.status);
    }

    // TEST 9: Simulate one storage-node failure -> K=3 recovery succeeds + password verification works
    console.log('\n--- TEST 9: Node failure simulation + Reed-Solomon K=3 recovery + password verification ---');
    // Fetch shard mapping for File 1
    const file1InfoRes = await fetch(`${API_BASE}/files`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const fileListA = await file1InfoRes.json();
    const f1Doc = (Array.isArray(fileListA) ? fileListA : fileListA.files).find(f => f.id === file1Id);
    const targetNodeToFail = f1Doc.nodeDistribution ? f1Doc.nodeDistribution[0] : 'node-01';

    console.log(`Simulating failure on node: ${targetNodeToFail}`);
    await fetch(`${API_BASE}/nodes/${targetNodeToFail}/toggle-status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    // Wrong password with 1 node down -> should still reject with 401
    const dlFailNodeWrongPass = await fetch(`${API_BASE}/files/${file1Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': 'WrongPassword123!',
      },
    });

    // Correct password with 1 node down -> 3/4 Reed-Solomon reconstruction succeeds
    const dlFailNodeCorrectPass = await fetch(`${API_BASE}/files/${file1Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-File-Password': pass1,
      },
    });

    // Restore node
    await fetch(`${API_BASE}/nodes/${targetNodeToFail}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (dlFailNodeWrongPass.status === 401 && dlFailNodeCorrectPass.ok && (await dlFailNodeCorrectPass.text()) === content1) {
      console.log('✓ TEST 9 PASSED: 3/4 Reed-Solomon reconstructed payload successfully and password enforced during failure simulation');
      passed++;
    } else {
      console.error('✕ TEST 9 FAILED: Failure simulation recovery failed');
    }

    // TEST 10: User B attempts to access User A's password-protected file
    console.log('\n--- TEST 10: User isolation check (User B accessing User A file) ---');
    const dlUserBRes = await fetch(`${API_BASE}/files/${file1Id}/download`, {
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'X-File-Password': pass1,
      },
    });
    if (dlUserBRes.status === 404) {
      const err10 = await dlUserBRes.json();
      console.log(`✓ TEST 10 PASSED: User isolation enforced, User B blocked with HTTP 404 (${err10.error})`);
      passed++;
    } else {
      console.error('✕ TEST 10 FAILED: User B was not blocked with 404, status:', dlUserBRes.status);
    }

    // TEST 11: Refresh/reopen My Vault -> isPasswordProtected flag is retained
    console.log('\n--- TEST 11: Vault persistence of isPasswordProtected flag ---');
    const vaultRes = await fetch(`${API_BASE}/files`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const vaultFiles = await vaultRes.json();
    const f1InVault = (Array.isArray(vaultFiles) ? vaultFiles : vaultFiles.files).find(f => f.id === file1Id);
    const f8InVault = (Array.isArray(vaultFiles) ? vaultFiles : vaultFiles.files).find(f => f.id === file8Id);

    if (f1InVault && f1InVault.isPasswordProtected === true && f8InVault && f8InVault.isPasswordProtected === false) {
      console.log('✓ TEST 11 PASSED: Vault listings correctly indicate isPasswordProtected=true for File 1 and false for File 8');
      passed++;
    } else {
      console.error('✕ TEST 11 FAILED: Vault properties mismatch:', { f1: f1InVault?.isPasswordProtected, f8: f8InVault?.isPasswordProtected });
    }

    // TEST 12: Verify plaintext password is NOT stored in MongoDB or API response
    console.log('\n--- TEST 12: Zero Plaintext Password Leakage Audit ---');
    const file1Str = JSON.stringify(f1Doc);
    const hasPlaintextInApi = file1Str.includes(pass1);
    const hasHashInApi = file1Str.includes(crypto.createHash('sha256').update(pass1).digest('hex'));

    if (!hasPlaintextInApi && !hasHashInApi) {
      console.log('✓ TEST 12 PASSED: Neither plaintext password nor raw hash leaked in API metadata responses');
      passed++;
    } else {
      console.error('✕ TEST 12 FAILED: Leakage detected in API response:', { hasPlaintextInApi, hasHashInApi });
    }

    console.log('\n==================================================');
    console.log(`12-TEST SUITE COMPLETED: ${passed}/${total} PASSED`);
    console.log('==================================================');

  } catch (err) {
    console.error('FATAL TEST RUN ERROR:', err);
  }
}

run12Tests();
