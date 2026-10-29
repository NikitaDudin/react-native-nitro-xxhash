const { rmSync } = require('node:fs');
const { resolve } = require('node:path');

rmSync(resolve(__dirname, '../lib'), { recursive: true, force: true });
