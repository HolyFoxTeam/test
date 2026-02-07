import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGINS_FILE = path.join(__dirname, '../plugins.v4.json');
const TEMP_DIR = path.join(__dirname, '../temp_scan');

// 危险特征正则库
const PATTERNS = {
    high: [
        { name: 'Exec/Spawn (RCE Risk)', regex: /child_process|exec\(|spawn\(|execSync|spawnSync/ },
        { name: 'Eval/Function (Code Injection)', regex: /eval\(|new Function\(/ },
        { name: 'Obfuscated Code (Hex)', regex: /_0x[a-f0-9]{4,}/ },
        { name: 'Minified/Obfuscated Line', regex: /.{1000,}/ }, // 单行超过1000字符
    ],
    medium: [
        { name: 'File System Write', regex: /fs\.writeFile|fs\.writeFileSync|fs\.append/ },
        { name: 'File System Delete', regex: /fs\.unlink|fs\.rm/ },
        { name: 'Process Exit', regex: /process\.exit/ },
    ],
    low: [
        { name: 'Network Request', regex: /http\.request|https\.request|axios|fetch\(/ },
        { name: 'Data Exfiltration Risk', regex: /base64/ },
    ]
};

// 忽略的文件类型
const IGNORE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.md', '.txt', '.json', '.yml', '.yaml'];

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Handle redirect
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

function unzip(zipPath, destDir) {
    try {
        // 尝试使用系统 unzip 命令 (Linux/Mac)
        execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'ignore' });
    } catch (e) {
        try {
            // 尝试使用 PowerShell Expand-Archive (Windows)
            execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'ignore' });
        } catch (e2) {
            console.error('Failed to unzip file. Ensure unzip (Linux) or PowerShell (Windows) is available.');
            throw e2;
        }
    }
}

function scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const risks = [];

    // Check line length for minified/obfuscated code first to avoid regex perf issues on huge lines
    const lines = content.split('\n');
    lines.forEach((line, index) => {
        const lineNum = index + 1;

        // High Risk Checks
        PATTERNS.high.forEach(p => {
            if (p.regex.test(line)) {
                risks.push({ level: 'HIGH', type: p.name, file: fileName, line: lineNum, code: line.trim().substring(0, 100) });
            }
        });

        // Medium Risk Checks
        PATTERNS.medium.forEach(p => {
            if (p.regex.test(line)) {
                risks.push({ level: 'MEDIUM', type: p.name, file: fileName, line: lineNum, code: line.trim().substring(0, 100) });
            }
        });
    });

    return risks;
}

function walkDir(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walkDir(filePath, fileList);
        } else {
            if (!IGNORE_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
                fileList.push(filePath);
            }
        }
    });
    return fileList;
}

async function getChangedPlugins() {
    try {
        // 在 CI 环境中，我们比较 HEAD 和 origin/main
        // 这里简化处理：如果没有传参，尝试读取 plugins.v4.json 里的所有插件（仅作测试用），
        // 或者解析 git diff。
        // 为了 CI 方便，我们假设会传入一个 changed_files 列表，或者我们直接对比
        // 简单起见，我们假设环境变量 CHANGED_PLUGINS 包含了 JSON 字符串，或者我们只扫描最新的 plugins.v4.json

        // 更好的策略：
        // 读取当前的 plugins.v4.json
        // 如果能执行 git 命令，获取 origin/main 版本可以通过 git show

        const currentContent = fs.readFileSync(PLUGINS_FILE, 'utf-8');
        const currentPlugins = JSON.parse(currentContent).plugins;

        let basePlugins = [];
        try {
            // 尝试获取基准版本 (origin/main)
            const baseContent = execSync('git show origin/main:plugins.v4.json', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
            basePlugins = JSON.parse(baseContent).plugins;
        } catch (e) {
            console.log('Could not fetch base version from git (origin/main). Scanning ALL plugins (or limited by logic).');
            // 如果无法获取 git 历史，可能是在本地测试，或者浅克隆。
            // 这种情况下，返回所有插件可能太耗时。
            // 我们可以只返回最后几个，或者全部。
            // 这里我们默认只输出差异。如果没差异环境，就全部扫描。
            // 为了安全起见，如果是本地运行且没 git，只扫描第一个做 demo 或者全部。
            return currentPlugins;
        }

        const baseMap = new Map(basePlugins.map(p => [p.id, p.version]));

        // Filter plugins that are new or have version updates
        const changed = currentPlugins.filter(p => {
            const baseVersion = baseMap.get(p.id);
            return !baseVersion || baseVersion !== p.version;
        });

        console.log(`Found ${changed.length} changed/new plugins.`);
        return changed;

    } catch (e) {
        console.error('Error calculating changes:', e);
        return [];
    }
}

async function checkWithAI(pluginName, risks) {
    if (!process.env.AI_API_KEY) return null;

    // Group risks
    const groups = {};
    risks.forEach(r => {
        const key = `${r.type} in ${r.file}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r.code);
    });

    let description = '';
    for (const [key, codes] of Object.entries(groups)) {
        description += `- **${key}** (${codes.length} occurrences)\n`;
        // Show first 3 examples
        codes.slice(0, 3).forEach(c => description += `  Code: \`${c}\`\n`);
    }

    const prompt = `你是一位代码安全专家，正在审查一个名为 "${pluginName}" 的 NapCat (QQ 机器人) 插件。
静态分析工具发现了以下潜在风险。
请对它们进行分析。请注意：
1. 压缩后的 HTML/JS 代码是常见的（例如 React/Vue 构建产物），通常是安全的。
2. 文件系统写入通常用于保存配置或数据，是插件的正常功能。
3. 网络请求用于获取数据，也是常见的。

发现的风险：
${description}

对于每一类风险，请判断它可能是 "误报 (False Positive)" 还是 "真阳性/可疑 (True Positive / Suspicious)"，并解释原因。
如果看起来是标准的插件行为（如保存配置、React 构建产物等），请将其标记为 "低风险 (Low Risk)"。
请使用 Markdown 格式返回你的分析结果，并且必须使用**中文**回答。

在分析的最后，请务必单独一行输出一个JSON对象，表明你认为该插件是否安全。格式如下：

\`\`\`json
{"is_safe": true}
\`\`\`
或者
\`\`\`json
{"is_safe": false}
\`\`\`
如果所有风险都是误报或低风险，is_safe 为 true；如果通过分析确认存在真实的恶意代码风险，is_safe 为 false。
`;

    try {
        const baseUrl = (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const url = `${baseUrl}/chat/completions`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.AI_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.AI_MODEL || 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: '你是一位乐于助人的代码安全审计员。' },
                    { role: 'user', content: prompt }
                ]
            })
        }); if (!response.ok) {
            console.error(`AI API Error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        return data.choices[0].message.content;
    } catch (e) {
        console.error('AI Check failed:', e);
        return null;
    }
}

async function main() {
    console.log('Starting Security Scan...');
    ensureDir(TEMP_DIR);

    const targetPlugins = await getChangedPlugins();

    if (targetPlugins.length === 0) {
        console.log('No changed plugins to scan.');
        return;
    }

    let report = '## :shield: Plugin Security Scan Report\n\n';
    let finalHighRisks = false;

    for (const plugin of targetPlugins) {
        let pluginHasHighRisks = false;
        console.log(`Scanning ${plugin.name} (${plugin.version})...`);
        const pluginTempDir = path.join(TEMP_DIR, plugin.id);
        ensureDir(pluginTempDir);

        const zipPath = path.join(pluginTempDir, 'package.zip');
        const extractPath = path.join(pluginTempDir, 'extract');
        ensureDir(extractPath);

        try {
            // 1. Download
            if (!plugin.downloadUrl) {
                report += `### ${plugin.name} ${plugin.version}\n:warning: **Skipped**: No downloadUrl provided.\n\n`;
                continue;
            }

            console.log(`  Downloading from ${plugin.downloadUrl}...`);
            await downloadFile(plugin.downloadUrl, zipPath);

            // 2. Unzip
            console.log(`  Extracting...`);
            unzip(zipPath, extractPath);

            // 3. Scan
            console.log(`  Analyzing code...`);
            const files = walkDir(extractPath);
            let pluginRisks = [];

            for (const file of files) {
                const risks = scanFile(file);
                if (risks.length > 0) {
                    pluginRisks = pluginRisks.concat(risks);
                }
            }

            // 4. Report
            if (pluginRisks.length === 0) {
                report += `### ${plugin.name} ${plugin.version}\n:white_check_mark: **Safe**: No suspicious patterns found.\n\n`;
            } else {
                const high = pluginRisks.filter(r => r.level === 'HIGH');
                const medium = pluginRisks.filter(r => r.level === 'MEDIUM');

                if (high.length > 0) pluginHasHighRisks = true;

                let icon = high.length > 0 ? ':rotating_light:' : ':warning:';
                report += `### ${plugin.name} ${plugin.version}\n${icon} **Risks Found**:\n`;

                if (high.length > 0) {
                    report += `#### High Severity\n`;
                    high.forEach(r => report += `- **${r.type}** in \`${r.file}:${r.line}\`: \`${r.code}\`\n`);
                }
                if (medium.length > 0) {
                    report += `#### Medium Severity\n`;
                    medium.forEach(r => report += `- **${r.type}** in \`${r.file}:${r.line}\`: \`${r.code}\`\n`);
                }
                report += '\n';

                // Call AI for analysis
                if (process.env.AI_API_KEY) {
                    console.log(`  Asking AI to analyze ${plugin.name} risks...`);
                    const aiAnalysis = await checkWithAI(plugin.name, pluginRisks);
                    if (aiAnalysis) {
                        report += `\n### 🤖 AI Analysis for ${plugin.name}\n\n`;
                        report += aiAnalysis + '\n\n';

                        // Parse AI verdict
                        const isSafeMatch = aiAnalysis.match(/"is_safe":\s*(true|false)/);
                        if (isSafeMatch) {
                            const isSafe = isSafeMatch[1] === 'true';
                            if (isSafe) {
                                pluginHasHighRisks = false; // AI says it's safe
                                report += `\n:white_check_mark: **AI Verdict**: Safe (False Positive).\n\n`;
                                console.log(`  AI determined ${plugin.name} is safe.`);
                            } else {
                                report += `\n:rotating_light: **AI Verdict**: Potential Risk Confirmed.\n\n`;
                                console.log(`  AI determined ${plugin.name} is risky.`);
                            }
                        }
                    }
                }
            }

            if (pluginHasHighRisks) {
                finalHighRisks = true;
            }

        } catch (e) {
            console.error(`  Error scanning ${plugin.id}:`, e);
            report += `### ${plugin.name} ${plugin.version}\n:x: **Error**: Failed to scan. (${e.message})\n\n`;
            // Scan error means risk unknown, conservatively mark as high risk
            finalHighRisks = true;
        }
    }

    // Output report to file for GitHub Actions to pick up
    fs.writeFileSync('security_report.md', report);

    // Set output for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_high_risks=${finalHighRisks}\n`);
    }

    // Write to GITHUB_STEP_SUMMARY if available
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    }

    console.log('Scan complete. Report generated: security_report.md');

    // Clean up
    cleanDir(TEMP_DIR);

    // 如果有高危风险，可以让脚本 exit 1 阻断 CI，或者只作为评论（exit 0）
    // 这里我们选择总是 exit 0，让 CI 继续把评论发出去，人工审核。
}

main();
