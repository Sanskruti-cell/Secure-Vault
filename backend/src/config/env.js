import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

const isProduction = process.env.NODE_ENV === 'production';

// Strict validation of required secrets
const requiredKeys = ['JWT_SECRET', 'ENCRYPTION_MASTER_KEY'];
if (isProduction) {
  requiredKeys.push('MONGODB_URI', 'FRONTEND_URL');
}

const missingKeys = requiredKeys.filter((key) => {
  const val = process.env[key];
  return !val || val.trim() === '';
});

if (missingKeys.length > 0) {
  throw new Error(
    `[FATAL CONFIG ERROR] Missing required environment variable(s): ${missingKeys.join(', ')}. ` +
    `Please set these in your environment or backend/.env file (see backend/.env.example).`
  );
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port: parseInt(process.env.PORT, 10) || 5002,
  mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/securevault',
  dbName: process.env.MONGODB_DB_NAME || 'securevault',
  jwtSecret: process.env.JWT_SECRET,
  masterKey: process.env.ENCRYPTION_MASTER_KEY,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  enableDemoAccounts: process.env.ENABLE_DEMO_ACCOUNTS === 'true',
};

