import { Router } from 'express';
import * as controllers from './controllers';

export const router = Router();

router.post('/migrations', controllers.createMigration);
router.get('/migrations', controllers.listMigrations);
router.get('/migrations/:id', controllers.getMigration);
router.get('/migrations/:id/events', controllers.listEvents);
router.post('/migrations/:id/analyze', controllers.analyze);
router.post('/migrations/:id/approve', controllers.approve);
router.post('/migrations/:id/reject', controllers.reject);
router.post('/migrations/:id/execute', controllers.execute);
