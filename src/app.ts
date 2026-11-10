import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';

import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import verificationRoutes from './routes/verification.routes';
import uploadsRoutes from './routes/uploads.routes';
import notificationsRoutes from './routes/notifications.routes';
import propertiesRoutes from './routes/properties.routes';
import bookingsRoutes from './routes/bookings.routes';
import reviewsRoutes from './routes/reviews.routes';
import reportsRoutes from './routes/reports.routes';
import chatRoutes from './routes/chat.routes';
import paymentsRoutes, { webhookRouter } from './routes/payments.routes';
import subscriptionsRoutes from './routes/subscriptions.routes';
import walletRoutes from './routes/wallet.routes';
import tenanciesRoutes from './routes/tenancies.routes';
import rentsaveRoutes from './routes/rentsave.routes';
import maintenanceRoutes from './routes/maintenance.routes';
import jobsRoutes from './routes/jobs.routes';
import artisanRoutes from './routes/artisan.routes';
import dashboardRoutes from './routes/dashboard.routes';
import adminRoutes from './routes/admin.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',') }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  // Keep the raw body: Paystack webhook signatures are computed over it.
  app.use(express.json({ limit: '1mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const general = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const strict = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  app.use('/webhooks', webhookRouter);
  app.use(general);

  const v1 = express.Router();
  v1.use('/auth', strict, authRoutes);
  v1.use('/users', usersRoutes);
  v1.use('/verification', verificationRoutes);
  v1.use('/uploads', uploadsRoutes);
  v1.use('/notifications', notificationsRoutes);
  v1.use('/properties', propertiesRoutes);
  v1.use('/bookings', bookingsRoutes);
  v1.use('/reviews', reviewsRoutes);
  v1.use('/reports', reportsRoutes);
  v1.use('/conversations', chatRoutes);
  v1.use('/payments', paymentsRoutes);
  v1.use('/subscriptions', subscriptionsRoutes);
  v1.use('/wallet', walletRoutes);
  v1.use('/tenancies', tenanciesRoutes);
  v1.use('/rentsave', rentsaveRoutes);
  v1.use('/maintenance', maintenanceRoutes);
  v1.use('/jobs', jobsRoutes);
  v1.use('/artisan', artisanRoutes);
  v1.use('/dashboard', dashboardRoutes);
  v1.use('/admin', adminRoutes);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
