import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const srcRoot = join(root, 'src');

const allowedFiles = new Set([
  'src/lib/cors-fetch.ts',
  'src/lib/web-platform.ts',
  'src/lib/media-source.ts',
  'src/app/api/ai/runninghub-test/route.ts',
  'src/app/api/proxy-image/route.ts',
]);

function isSourceFile(path) {
  return /\.(ts|tsx)$/.test(path);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else if (isSourceFile(path)) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];

for (const file of walk(srcRoot)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (allowedFiles.has(rel)) continue;

  const source = stripComments(readFileSync(file, 'utf8'));
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (/\bfetch\s*\(/.test(line)) {
      violations.push(`${rel}:${index + 1}`);
    }
  });
}

if (violations.length > 0) {
  console.error('业务代码禁止直接 fetch，请改用 src/lib/cors-fetch.ts 的 corsFetch。');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Network fetch check passed.');
