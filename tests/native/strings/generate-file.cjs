const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const destination = process.argv[2];
if (!destination) throw new Error('Expected destination file path');
const bytes = 500_000_000;
const blockBytes = 65_536;
const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-\n';
const base = Buffer.alloc(blockBytes);
for (let offset = 0; offset < base.length; offset++)
  base[offset] = alphabet.charCodeAt(offset % alphabet.length);
const block = Buffer.alloc(blockBytes);
const hash = crypto.createHash('sha256');
const fd = fs.openSync(destination, 'wx');
try {
  for (let index = 0, position = 0; position < bytes; index++, position += blockBytes) {
    base.copy(block);
    block.write('xxhash block:' + index.toString(16).padStart(12, '0') + '\n', 0, 'ascii');
    const count = Math.min(blockBytes, bytes - position);
    let written = 0;
    while (written < count) written += fs.writeSync(fd, block, written, count - written);
    hash.update(block.subarray(0, count));
  }
} finally {
  fs.closeSync(fd);
}
if (fs.statSync(destination).size !== bytes) throw new Error('Fixture length mismatch');
console.log(
  JSON.stringify({ fixture: path.resolve(destination), bytes, sha256: hash.digest('hex') }),
);
