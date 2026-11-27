import { Router } from 'express';
import { authenticate, requireRole } from './auth';
import * as controllers from './controllers';

export const router = Router();

// Público
router.post('/auth/login', controllers.login);

// Qualquer usuário autenticado (DBA ou DEV_QA). Com AUTH_ENABLED=false, todos passam.
router.use(authenticate);
router.get('/auth/me', controllers.me);
router.get('/metrics', controllers.metrics);
router.post('/migrations', controllers.createMigration);
router.get('/migrations', controllers.listMigrations);
router.get('/migrations/:id', controllers.getMigration);
router.get('/migrations/:id/events', controllers.listEvents);
router.post('/migrations/:id/analyze', controllers.analyze);

// Homologação e execução: só o DBA.
const dbaOnly = requireRole('DBA');
router.post('/migrations/:id/approve', dbaOnly, controllers.approve);
router.post('/migrations/:id/reject', dbaOnly, controllers.reject);
router.post('/migrations/:id/execute', dbaOnly, controllers.execute);
