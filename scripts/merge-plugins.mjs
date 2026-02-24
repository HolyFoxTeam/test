#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const MAIN_FILE = process.env.MAIN_FILE;
const STORE_FILE = process.env.STORE_FILE;
const OUTPUT_FILE = process.env.OUTPUT_FILE;

if (!MAIN_FILE || !STORE_FILE || !OUTPUT_FILE) {
  console.error('❌ 请设置 MAIN_FILE, STORE_FILE, OUTPUT_FILE 环境变量');
  process.exit(1);
}

function readJSON(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`❌ 读取文件失败 ${file}:`, err.message);
    process.exit(1);
  }
}

const mainData = readJSON(MAIN_FILE);
let storeData = { plugins: [] };
try {
  storeData = readJSON(STORE_FILE);
} catch (err) {
  console.log('⚠️ store 文件不存在，将视为空数据');
}

// 构建 store 插件的映射，方便查找下载量
const storePluginMap = new Map();
if (storeData.plugins) {
  for (const p of storeData.plugins) {
    storePluginMap.set(p.id, p.downloadCount ?? 0);
  }
}

// 合并插件列表
const mergedPlugins = [];
if (mainData.plugins) {
  for (const mainPlugin of mainData.plugins) {
    const merged = { ...mainPlugin }; // 复制 main 的所有字段
    // 保留 store 中的下载量，如果没有则设为 0
    merged.downloadCount = storePluginMap.has(mainPlugin.id)
      ? storePluginMap.get(mainPlugin.id)
      : 0;
    mergedPlugins.push(merged);
  }
}

// 更新数据
mainData.plugins = mergedPlugins;

// 写回文件
writeFileSync(OUTPUT_FILE, JSON.stringify(mainData, null, 2), 'utf-8');
console.log('✅ 插件数据合并完成，已保留 store 中的下载量');