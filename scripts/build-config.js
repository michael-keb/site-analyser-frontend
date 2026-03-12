#!/usr/bin/env node
const fs = require('fs');
const apiUrl = process.env.API_URL || 'http://localhost:8000';
const apiBase = apiUrl.replace(/\/$/, '') + '/api';
const content = `// Generated at build time\nwindow.SITE_ANALYSER_API_BASE = '${apiBase}';\n`;
fs.writeFileSync('js/config.js', content);
console.log('Built config.js with API_URL:', apiBase);
