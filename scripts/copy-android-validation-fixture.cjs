const fs = require('node:fs');
const path = require('node:path');

const ignored = new Set(['node_modules', '.git', '.gradle', '.cxx', 'build', 'lib']);

function copyAndroidValidationFixture(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => entry === source || !ignored.has(path.basename(entry)),
  });
}

module.exports = { copyAndroidValidationFixture };
