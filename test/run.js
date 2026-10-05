'use strict';
const path = require('path');
const fs = require('fs');
const dir = path.join(__dirname, '..', 'data', 'test');
fs.rmSync(dir, { recursive: true, force: true });
process.env.DATA_DIR = dir;
process.env.PORT = '8099';
require('./acceptance.js');
