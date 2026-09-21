const { cpSync } = require('node:fs');
for (const directory of ['views', 'public']) cpSync(directory, `dist/${directory}`, { recursive: true });
