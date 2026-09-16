#!/usr/bin/env node
// 跨平台语法检查：对所有 .js 执行 node --check
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'reference']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ 语法错误: ${path.relative(ROOT, f)}`);
    bad++;
  }
}
console.log(`语法检查完成: ${files.length} 个文件, ${bad} 个失败`);
process.exitCode = bad === 0 ? 0 : 1;