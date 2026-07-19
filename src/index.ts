import express from 'express';
import cors from 'cors';
import config from './config';
import authRoutes from './routes/auth';
import playerRoutes from './routes/player';
import scoutRoutes from './routes/scout';
import validatorRoutes from './routes/validator';
import adminRoutes from './routes/admin';
import { errorHandler } from './middleware/errorHandler';
import { securityHeaders } from './middleware/securityHeaders';
import { correlationId } from './middleware/correlationId';
import { responseTime } from './middleware/responseTime';
import { idempotencyMiddleware, startIdempotencyPurgeJob } from './middleware/idempotency';
import { indexEvents } from './services/indexer';
import { logger } from './utils/logger';
import { stellarHealth } from './services/stellar';
import { checkHealth } from './services/ipfs';

const app = express();

app.use(cors());
app.use(correlationId);
app.use(securityHeaders);
app.use(responseTime);
app.use(express.json());
app.use(idempotencyMiddleware);

app.get('/health', async (_req, res) => {
  const healthStatus: Record<string, 'ok' | 'error' | 'disabled'> = {};

  if (config.stellarHealthCheckEnabled) {
    const stellarOk = await stellarHealth();
    healthStatus.stellar = stellarOk ? 'ok' : 'error';
  } else {
    healthStatus.stellar = 'disabled';
  }

  res.json({ status: 'ok', healthStatus });
});

// Kubernetes-style liveness and readiness probes
app.get('/health/liveness', (_req, res) => {
  // Liveness checks only that the process is up
  res.json({ status: 'ok' });
});

app.get('/health/readiness', async (_req, res) => {
  const services: Record<string, 'ok' | 'unavailable' | 'disabled'> = {};

  // Check IPFS/Pinata availability
  try {
    await checkHealth();
    services.ipfs = 'ok';
  } catch {
    services.ipfs = 'unavailable';
  }

  // Check Stellar RPC if enabled
  if (config.stellarHealthCheckEnabled) {
    try {
      const stellarOk = await stellarHealth();
      services.stellar = stellarOk ? 'ok' : 'unavailable';
    } catch {
      services.stellar = 'unavailable';
    }
  } else {
    services.stellar = 'disabled';
  }

  const allOk = Object.values(services).every(v => v === 'ok' || v === 'disabled');
  if (allOk) {
    res.json({ status: 'ok', services });
  } else {
    res.status(503).json({ status: 'degraded', services });
  }
});

app.use('/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/scouts', scoutRoutes);
app.use('/api/validators', validatorRoutes);
app.use('/api/admin', adminRoutes);

app.use(errorHandler);

app.listen(config.port, () => {
  logger.info(`ScoutOff backend running on port ${config.port} [${config.network}]`);

  // Log startup health of critical dependencies
  (async () => {
    const statuses: Record<string, string> = {};
    try {
      await checkHealth();
      statuses.ipfs = 'ok';
    } catch {
      statuses.ipfs = 'unavailable';
    }

    if (config.stellarHealthCheckEnabled) {
      try {
        const sOk = await stellarHealth();
        statuses.stellar = sOk ? 'ok' : 'unavailable';
      } catch {
        statuses.stellar = 'unavailable';
      }
    } else {
      statuses.stellar = 'disabled';
    }

    logger.info(`Startup health: ${JSON.stringify(statuses)}`);
  })();

  // Poll for new contract events every 5 seconds
  const poll = async () => {
    try {
      await indexEvents();
    } catch (err) {
      logger.error('Indexer error:', (err as Error).message);
    }
  };

  poll();
  setInterval(poll, 5_000);
  startIdempotencyPurgeJob();
});

export default app;
