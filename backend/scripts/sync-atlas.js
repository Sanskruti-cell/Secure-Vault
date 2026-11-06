import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { syncStoreWithMongo, loadStoredFiles, loadStoredShards } from '../src/services/storeService.js';

console.log('='.repeat(70));
console.log('SECUREVAULT -> MONGODB ATLAS DIRECT SYNC DIAGNOSTIC UTILITY');
console.log('='.repeat(70));

const uri = env.mongoUri;
console.log('[1] Target URI Host: cluster0.unzftil.mongodb.net');
console.log('[2] Target Database:', env.mongoDbName || 'securevault');

const localFiles = loadStoredFiles();
const localShards = loadStoredShards();
console.log(`[3] Local records pending in store: ${localFiles.length} file(s), ${localShards.length} shard(s)`);
localFiles.forEach(f => console.log(`    -> File: "${f.fileName || f.name}" (ID: ${f.id})`));

console.log('\n[4] Attempting direct TLS connection to MongoDB Atlas...');
try {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
  });
  console.log('>>> SUCCESS: Connected to MongoDB Atlas! <<<');
  
  console.log('\n[5] Synchronizing all local files and shards to MongoDB Atlas...');
  await syncStoreWithMongo();
  
  const { File } = await import('../src/models/File.js');
  const { FileShard } = await import('../src/models/FileShard.js');
  
  const atlasFiles = await File.find({}).lean();
  const atlasShards = await FileShard.find({}).lean();
  
  console.log('\n' + '='.repeat(70));
  console.log(`VERIFICATION CONFIRMED:`);
  console.log(`Total Files in MongoDB Atlas:  ${atlasFiles.length}`);
  console.log(`Total Shards in MongoDB Atlas: ${atlasShards.length}`);
  atlasFiles.forEach(f => {
    console.log(`  * File in Atlas: "${f.fileName}" | ID: ${f._id} | Size: ${f.fileSize}B | Shards: ${f.totalShards || 6}`);
  });
  console.log('='.repeat(70));
  
  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('\n>>> CONNECTION FAILED TO MONGO ATLAS <<<');
  console.error('Error Details:', err.message);
  if (err.cause) console.error('Underlying Cause:', err.cause.message || err.cause);
  
  console.log('\nDIAGNOSTIC GUIDANCE:');
  console.log('1. If the error mentions ECONNRESET or IP Whitelist:');
  console.log('   Go to MongoDB Atlas -> Network Access -> Add IP Address -> choose "ALLOW ACCESS FROM ANYWHERE" (0.0.0.0/0).');
  console.log('2. If on college/university Wi-Fi (SIT Nagpur):');
  console.log('   The campus firewall often blocks outbound port 27017.');
  console.log('   Switch Wi-Fi to a Mobile Hotspot (phone 4G/5G) and re-run this script.');
  process.exit(1);
}
