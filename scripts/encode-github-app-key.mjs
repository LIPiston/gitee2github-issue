#!/usr/bin/env node
/**
 * 把 GitHub App 的 PKCS#8 私钥转成「单行 + 字面 \n」的字符串，写到 stdout，
 * 供 `npx wrangler secret put GITHUB_PRIVATE_KEY` 使用。
 *
 * 用法：
 *   node scripts/encode-github-app-key.mjs /path/to/pkcs8-private-key.pem | npx wrangler secret put GITHUB_PRIVATE_KEY
 *
 * 注意（踩过的坑）：
 *   1. GitHub 下载到的私钥是 PKCS#1，必须先转 PKCS#8：
 *      openssl pkcs8 -topk8 -inform PEM -outform PEM -in 原始.pem -out 转换后.pem -nocrypt
 *      否则运行时会报：Private Key is in PKCS#1 format, but only PKCS#8 is supported.
 *   2. 不要用 `tr '\n' 'Z' | sed 's/Z/\\n/g'` 之类的占位符替换来压成单行：
 *      base64 正文本身含大写字母 Z，会被一并替换掉，运行时表现为
 *      atob() called with invalid base64-encoded data。本脚本会先自校验再输出。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const pemPath = process.argv[2];
if (!pemPath) {
  console.error('用法: node scripts/encode-github-app-key.mjs <pkcs8-private-key.pem>');
  process.exit(1);
}

const pem = fs.readFileSync(pemPath, 'utf8');
// 单行 + 字面 \n；Worker 侧会用 .replace(/\\n/g, '\n') 还原
const oneLine = pem.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\\n');

// 自校验：确认还原后是合法私钥
const decoded = oneLine.replace(/\\n/g, '\n');
let key;
try {
  key = crypto.createPrivateKey({ key: decoded, format: 'pem' });
} catch (error) {
  console.error('[失败] 无法解析该私钥，请确认它是 PKCS#8 格式：', error.message);
  process.exit(1);
}

process.stderr.write(
  `[verify] 单行长度=${oneLine.length} 行数=${oneLine.split('\\n').length} ` +
    `解码后字节=${decoded.length} 类型=${key.asymmetricKeyType}\n`
);
process.stdout.write(oneLine);
