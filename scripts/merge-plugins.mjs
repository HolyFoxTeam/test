#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';

// 解析命令行参数
const options = {
  main: { type: 'string' },
  store: { type: 'string' },
  output: { type: 'string' },
};

let mainFile, storeFile, outputFile;

try {
  const { values } = parseArgs({ options, strict: false });
  mainFile = values.main;
  storeFile = values.store;
  outputFile = values.output;
} catch {
  // 解析失败则忽略，尝试使用环境变量
}

// 如果命令行参数缺失，回退到环境变量
mainFile = mainFile || process.env.MAIN_FILE;
storeFile = storeFile || process.env.STORE_FILE;
outputFile = outputFile || process.env.OUTPUT_FILE;

if (!mainFile || !storeFile || !outputFile) {
  console.error('❌ 请通过命令行参数 --main, --store, --output 或环境变量 MAIN_FILE, STORE_FILE, OUTPUT_FILE 指定文件路径');
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

const mainData = readJSON(mainFile);
let storeData = { plugins: [] };
try {
  storeData = readJSON(storeFile);
} catch (err) {
  console.log('⚠️ store 文件不存在或无效，将视为空数据');
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
writeFileSync(outputFile, JSON.stringify(mainData, null, 2), 'utf-8');
console.log('✅ 插件数据合并完成，已保留 store 中的下载量');