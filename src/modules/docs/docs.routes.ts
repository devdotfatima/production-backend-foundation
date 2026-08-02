import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { openApiDocument } from '#app/modules/docs/docs.document.js';

export const docsRouter = Router();

const swaggerAssetsDirectory = dirname(
  fileURLToPath(import.meta.resolve('swagger-ui-dist/swagger-ui.css')),
);

export const swaggerHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Backend Foundation API Docs</title>
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js" defer></script>
  <script src="/docs/swagger-initializer.js" defer></script>
</body>
</html>`;

export const swaggerInitializer = `window.ui = SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  displayRequestDuration: true,
});`;

docsRouter.use(
  '/docs/assets',
  express.static(swaggerAssetsDirectory, {
    index: false,
    maxAge: '1d',
    immutable: false,
  }),
);

docsRouter.get('/docs/swagger-initializer.js', (_request, response) => {
  response.type('application/javascript').send(swaggerInitializer);
});

docsRouter.get(['/openapi.json', '/api/v1/openapi.json'], (_request, response) => {
  response.json(openApiDocument);
});

docsRouter.get(['/docs', '/api/v1/docs'], (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.type('html').send(swaggerHtml);
});
