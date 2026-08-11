import { initializeTracing } from '#app/observability/tracing.js';
import { initializeSentry } from '#app/observability/sentry.js';

initializeTracing();
initializeSentry();
