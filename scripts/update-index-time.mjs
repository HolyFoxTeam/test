#!/usr/bin/env node
/**
 * 自动更新 plugins.v4.json 的 updateTime 字段
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLUGINS_FILE = resolve(ROOT, 'plugins.v4.json');

const content = readFileSync(PLUGINS_FILE, 'utf-8');
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const pattern = /"updateTime"\s*:\s*"[^"]*"/;
if (!pattern.test(content)) {
    console.error('updateTime 字段不存在，无法更新');
    process.exit(1);
}

const updated = content.replace(pattern, `"updateTime": "${now}"`);
if (updated === content) {
    console.log('updateTime 已是最新，无需更新');
    process.exit(0);
}

writeFileSync(PLUGINS_FILE, updated, 'utf-8');
console.log(`updateTime 已更新为 ${now}`);
