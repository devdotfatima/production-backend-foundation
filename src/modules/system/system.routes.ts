import { Router } from 'express';
import { health, readiness } from '#app/modules/system/system.controller.js';

export const systemRouter = Router();

systemRouter.get('/health', health);
systemRouter.get('/ready', readiness);
