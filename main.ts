// main.ts (最终修复版：修正了拼写错误和v1beta路径问题)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// --- 配置 ---
// --- 核心修复：修正这里的拼写错误 ---
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1";

// 1. 我的服务器的认证密钥
const MY_SERVER_SECRET_KEY = Deno.env.get("MY_SERVER_SECRET_KEY");

// 2. Gemini API 密钥
const GEMINI_API_KEYS_STR = Deno.env.get("GEMINI_API_KEYS");
let GEMINI_AI_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_AI_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

// (为了简洁，省略了与之前相同的启动检查、getRandomGeminiApiKey、getClientSecretKeyFromRequest函数，
// 请确保在你的最终代码中保留它们。下面的代码块是完整的，可以直接复制使用)

// --- 日志和启动检查 ---
console.log("========================");
console.log("  Gemini API 代理服务器 (final-fix)");
console.log("========================");
console.log("=== 服务器启动配置检查 ===");
console.log(`MY_SERVER_SECRET_KEY 设置状态: ${MY_SERVER_SECRET_KEY ? '已设置' : '未设置 (代理将无法工作)'}`);
console.log(`Gemini API Keys 数量: ${GEMINI_AI_KEYS.length} 个`);
if (GEMINI_AI_KEYS.length > 0) {
  console.log(`Gemini API Keys 长度概览: ${GEMINI_AI_KEYS.map(k => k.length > 0 ? `${k.substring(0, 4)}...` : '空').join(', ')}`);
}
if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
  console.error("\n!!! 启动失败：环境变量 MY_SERVER_SECRET_KEY 或 GEMINI_API_KEYS 未正确配置 !!!");
  console.error("请在 Deno Deploy 中设置以上环境变量。\n");
}
console.log("========================");

// 随机选择一个 Gemini API Key
function getRandomGeminiApiKey(): string {
  if (GEMINI_AI_KEYS.length === 0) {
    throw new Error("Gemini API Key 列表为空。");
  }
  const randomIndex = Math.floor(Math.random() * GEMINI_AI_KEYS.length);
  return GEMINI_AI_KEYS[randomIndex];
}

// 尝试从请求中获取访问代理的密钥
function getClientSecretKeyFromRequest(req: Request): { key: string | undefined, source: string } {
    const url = new URL(req.url);
    const headers = req.headers;
    let key: string | undefined = undefined;
    let source = "未找到";
    const porApiKey = headers.get("x-por-api-key");
    if (porApiKey) { key = porApiKey.trim(); source = "x-por-api-key header"; }
    const xApiKey = headers.get("x-api-key");
    if (!key && xApiKey) { key = xApiKey.trim(); source = "x-api-key header"; }
    const authHeader = headers.get("Authorization");
    if (!key && authHeader) {
        if (authHeader.toLowerCase().startsWith("bearer ")) { key = authHeader.substring(7).trim(); source = "Authorization: Bearer";
        } else { key = authHeader.trim(); source = "Authorization (direct)"; }
    }
    const googApiKey = headers.get("x-goog-api-key");
    if (!key && googApiKey) { key = googApiKey.trim(); source = "x-goog-api-key header"; }
    if (!key) {
        const urlKey = url.searchParams.get("key");
        if (urlKey) { key = urlKey.trim(); source = "URL parameter 'key'"; }
    }
    return { key, source };
}

// --- 主请求处理函数 ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  
  console.log(`\n[${requestId}] === 收到请求: ${req.method} ${url.pathname} ===`);

  // --- CORS 预检请求处理 ---
  const originHeader = req.headers.get("origin");
  const allowedOrigin = originHeader || "*"; 

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key",
      },
    });
  }

  // --- 服务器配置和客户端认证 ---
  if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
    return new Response(JSON.stringify({ error: "服务器配置错误" }), { status: 500 });
  }
  const { key: clientSecretKey } = getClientSecretKeyFromRequest(req);
  if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "认证失败" }), { status: 401 });
  }

  // --- 路径处理逻辑 ---
  let servicePathSegment = url.pathname; 
  while (servicePathSegment.startsWith('/')) {
      servicePathSegment = servicePathSegment.substring(1);
  }
  const prefixMatch = servicePathSegment.match(/^(v1\/|v1beta\/)/);
  if (prefixMatch) {
      servicePathSegment = servicePathSegment.substring(prefixMatch[0].length);
      console.log(`[${requestId}] 检测到并移除了 API 版本前缀: "${prefixMatch[0]}"`);
  }

  // 将基础URL中的/v1去掉，然后拼接处理后的路径
  const finalTargetUrl = `${GEMINI_API_BASE.replace('/v1', '')}/${servicePathSegment}`;
  
  const finalUrl = new URL(finalTargetUrl);
  finalUrl.search = url.searchParams.toString();
  finalUrl.searchParams.set("key", getRandomGeminiApiKey()); // 添加正确的 Gemini Key

  console.log(`[${requestId}] 目标 Gemini API URL: ${finalUrl.toString()}`); 

  // --- 转发请求 ---
  const forwardHeaders = new Headers(req.headers);
  ["host", "authorization", "x-api-key", "x-goog-api-key", "x-por-api-key", "key"].forEach(h => forwardHeaders.delete(h));

  try {
    const geminiResponse = await fetch(finalUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.body,
    });
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Gemini API 响应状态: ${geminiResponse.status} (${responseTime}ms)`);
    
    const responseHeaders = new Headers(geminiResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
    return new Response(geminiResponse.body, { status: geminiResponse.status, headers: responseHeaders });

  } catch (error) {
    console.error(`[${requestId}] 请求 Gemini API 时发生网络或fetch错误:`, error);
    return new Response(JSON.stringify({ error: "与 Gemini API 通信时发生错误"}), { status: 502 });
  }
}

// --- 启动服务器 ---
console.log("Gemini API 代理服务器已启动 (final-fix)。");
serve(handler);
