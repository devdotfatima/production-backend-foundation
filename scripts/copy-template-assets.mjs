import { cpSync, statSync } from 'node:fs';

// tsc already compiled the .ts files in this directory into dist/; only the .txt/.html template
// bodies need copying alongside them, since they are not TypeScript and tsc ignores them.
const source = 'src/modules/notifications/templates';
const destination = 'dist/src/modules/notifications/templates';

cpSync(source, destination, {
  recursive: true,
  filter: (path) => statSync(path).isDirectory() || /\.(txt|html)$/.test(path),
});
