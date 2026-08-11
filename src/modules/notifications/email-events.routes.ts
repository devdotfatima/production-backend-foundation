import express, { Router } from 'express';
import { receiveEmailEvent } from '#app/modules/notifications/email-events.controller.js';

export const emailEventsRouter = Router();
emailEventsRouter.post(
  '/',
  express.raw({ type: 'application/json', limit: '256kb' }),
  receiveEmailEvent,
);
