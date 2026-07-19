import dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();

const ConfigSchema = z.object({
  port: z.coerce.number().default(4000),
  network: z.enum(['testnet', 'mainnet']).default('testnet'),
  networkPassphrase: z.string().default('Test SDF Network ; September 2015'),
  horizonUrl: z.string().url().default('https://horizon-testnet.stellar.org'),
  sorobanRpcUrl: z.string().url().default('https://soroban-testnet.stellar.org'),
  contractId: z.string().min(1),
  jwtSecret: z.string().min(1),
  pinata: z.object({
    apiKey: z.string().default(''),
    secret: z.string().default(''),
    gateway: z.string().url().default('https://gateway.pinata.cloud'),
  }),
  platformFeeBps: z.coerce.number().default(500),
  dbPath: z.string().default('scout-off.db'),
});

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT ?? '4000', 10),
  network: (process.env.NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  horizonUrl:
    process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl:
    process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  contractId: required('CONTRACT_ID'),
  jwtSecret: required('JWT_SECRET'),
  pinata: {
    apiKey: process.env.PINATA_API_KEY ?? '',
    secret: process.env.PINATA_SECRET ?? '',
    gateway: process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud',
  },
  platformFeeBps: parseInt(process.env.PLATFORM_FEE_BPS ?? '500', 10),
  dbPath: process.env.DB_PATH ?? 'scout-off.db',
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  stellarHealthCheckEnabled: process.env.STELLAR_HEALTH_CHECK !== 'false',
  adminWallet: process.env.ADMIN_WALLET ?? '',
  securityHeaders: {
    hsts: process.env.SECURITY_HSTS ?? 'max-age=31536000; includeSubDomains',
    xContentTypeOptions: process.env.SECURITY_X_CONTENT_TYPE_OPTIONS ?? 'nosniff',
    xFrameOptions: process.env.SECURITY_X_FRAME_OPTIONS ?? 'DENY',
    referrerPolicy: process.env.SECURITY_REFERRER_POLICY ?? 'no-referrer',
  },
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED === 'true',
    url: process.env.WEBHOOK_URL ?? ''
  },
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED === 'true',
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10),
  },
  idempotency: {
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS ?? '86400', 10),
    purgeIntervalMs: parseInt(process.env.IDEMPOTENCY_PURGE_INTERVAL_MS ?? '60000', 10),
  },
};

export default config;
