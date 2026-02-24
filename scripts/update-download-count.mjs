#!/usr/bin/env node
/**
 * 更新插件下载量
 * 通过 GitHub API 获取 Release 下载量并更新到 plugins.v4.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLUGINS_FILE = resolve(ROOT, 'plugins.v4.json');

const GITHUB_API_BASE = 'https://api.github.com';
const CONCURRENCY = 5;
const RETRY_TIMES = 2;
const RETRY_DELAY = 1000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ❌ ${msg}`);
}

function logOk(msg) {
  console.log(`[${new Date().toISOString()}] ✅ ${msg}`);
}

function checkFileExists(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  log(`找到插件配置文件: ${filePath}`);
}

function extractGitHubRepo(downloadUrl) {
  try {
    const url = new URL(downloadUrl);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(p => p);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

async function fetchWithRetry(url, options = {}, retry = RETRY_TIMES) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`GitHub API 返回 ${res.status} (${res.statusText})`);
    }
    return res.json();
  } catch (err) {
    if (retry > 0) {
      log(`请求失败，剩余重试次数: ${retry}，错误: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchWithRetry(url, options, retry - 1);
    }
    throw err;
  }
}

async function fetchGitHubReleases(owner, repo, token = null) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases`;
  const headers = {
    'User-Agent': 'napcat-plugin-index',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token}`;

  return fetchWithRetry(url, { headers });
}

async function getDownloadCountForPlugin(plugin, token) {
  const { downloadUrl } = plugin;
  const repoInfo = extractGitHubRepo(downloadUrl);

  if (!repoInfo) {
    return { plugin, count: null, error: '无法从 downloadUrl 提取 GitHub 仓库信息' };
  }

  try {
    const releases = await fetchGitHubReleases(repoInfo.owner, repoInfo.repo, token);
    let totalCount = 0;

    for (const release of releases) {
      if (release.assets) {
        for (const asset of release.assets) {
          totalCount += asset.download_count || 0;
        }
      }
    }

    return { plugin, count: totalCount, error: null };
  } catch (err) {
    return { plugin, count: null, error: err.message };
  }
}

function getBeijingTime() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

async function updateDownloadCounts(token, updatePluginTime = false) {
  checkFileExists(PLUGINS_FILE);

  if (updatePluginTime) {
    log('开始更新插件下载量和插件 updateTime...');
  } else {
    log('开始更新插件下载量...');
  }

  let content;
  try {
    content = readFileSync(PLUGINS_FILE, 'utf-8');
  } catch (err) {
    throw new Error(`读取文件失败: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`解析 JSON 失败: ${err.message}`);
  }

  const plugins = data.plugins || [];
  if (plugins.length === 0) {
    log('⚠️ 未找到任何插件数据');
    return;
  }

  const results = [];

  for (let i = 0; i < plugins.length; i += CONCURRENCY) {
    const batch = plugins.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(plugin => getDownloadCountForPlugin(plugin, token))
    );
    results.push(...batchResults);
  }

  const beijingNow = getBeijingTime();
  let downloadCountUpdated = 0;
  let hasAnyChange = false;

  for (const result of results) {
    const { plugin, count, error } = result;

    const pluginIndex = plugins.findIndex(p => p.id === plugin.id);
    if (pluginIndex !== -1) {
      const originalCount = plugins[pluginIndex].downloadCount || 0;

      if (error) {
        logError(`[${plugin.id}] 获取下载量失败: ${error}`);
        plugins[pluginIndex].downloadCount = originalCount;
      } else {

        if (plugins[pluginIndex].downloadCount !== count) {
          hasAnyChange = true;
          downloadCountUpdated++;
        }
        plugins[pluginIndex].downloadCount = count;
        logOk(`[${plugin.id}] 下载量: ${count}`);
      }

      if (updatePluginTime) {
        hasAnyChange = true;
        plugins[pluginIndex].updateTime = beijingNow;
        logOk(`[${plugin.id}] updateTime 已设置为: ${beijingNow}`);
      }
    }
  }

  if (hasAnyChange) {
    try {
      writeFileSync(PLUGINS_FILE, JSON.stringify(data, null, 2), 'utf-8');
      log(`✅ 文件已写入，共更新 ${downloadCountUpdated} 个插件的下载量`);
    } catch (err) {
      throw new Error(`写入文件失败: ${err.message}`);
    }
  } else {
    log('ℹ️ 无任何数据变化，跳过文件写入');
  }

  if (updatePluginTime) {
    log(`更新完成，共更新 ${downloadCountUpdated} 个插件的下载量，所有插件的 updateTime 已更新为 ${beijingNow}`);
  } else {
    log(`下载量更新完成，共更新 ${downloadCountUpdated} 个插件`);
  }
}

(async () => {
  const token = process.env.GITHUB_TOKEN || null;
  const updatePluginTime = process.env.UPDATE_PLUGIN_TIME === 'true';

  try {
    await updateDownloadCounts(token, updatePluginTime);
  } catch (err) {
    logError(`脚本执行失败: ${err.message}`);
    process.exit(1);
  }
})();