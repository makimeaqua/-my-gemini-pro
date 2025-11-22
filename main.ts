// main.ts (已修复 v1beta 路径问题)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// --- 配置 ---
// Gemini API 的基础 URL，注意：已经包含 /v1
const GEMINI_API_BASE = "https://generativela..googleapis.com/v1";

// 1. 我的服务器的认证密钥，用于验证谁能访问我的代理 (AI软件 发送)
const MY_SERVER_SECRET_KEY = Deno.env.get("MY_SERVER_SECRET_KEY");

// 2. Gemini API 密钥 (可以是一个或多个，用逗号分隔)
const GEMINI_API_KEYS_STR = Deno.env.get("GEMINI_API_KEYS");
let GEMINI_AI_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_AI_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

// --- 日志和启动检查 ---
// (这部分代码与原来完全相同，为了简洁省略，实际部署时请保留)
console.log("========================");
console.log("  Gemini API 代理服务器 (v1beta fix)");
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
    throw new Error("Gemini API Key 列表为空。请检查环境变量 'GEMINI_API_KEYS'");
  }
  const randomIndex = Math.floor(Math.random() * GEMINI_AI_KEYS.length);
  const selectedKey = GEMINI_AI_KEYS[randomIndex];
  console.log(`[Key Pool] 使用 Gemini API Key #${randomIndex + 1}/${GEMINI_AI_KEYS.length} (长度: ${selectedKey.length}, 前4位: ${selectedKey.substring(0, 4)}...)`);
  return selectedKey;
}

// 尝试从 AI软件 发送的请求中获取访问代理的密钥
function getClientSecretKeyFromRequest(req: Request): { key: string | undefined, source: string } {
    const url = new URL(req.url);
    const headers = req.headers;
    let key: string | undefined = undefined;
    let source = "未找到";

    // 优先检查 x-por-api-key 
    const porApiKey = headers.get("x-por-api-key");
    if (porApiKey) {
        key = porApiKey.trim();
        source = "x-por-api-key header";
    }
    // 检查 X-Api-Key (通用)
    const xApiKey = headers.get("x-api-key");
    if (!key && xApiKey) {
        key = xApiKey.trim();
        source = "x-api-key header";
    }
    // 检查 Authorization Header
    const authHeader = headers.get("Authorization");
    if (!key && authHeader) {
        if (authHeader.toLowerCase().startsWith("bearer ")) {
            key = authHeader.substring(7).trim(); // 移除 "bearer "
            source = "Authorization: Bearer";
        } else {
            key = authHeader.trim();
            source = "Authorization (direct)";
        }
    }
    // 检查 x-goog-api-key (Google 服务的 Header)
    const googApiKey = headers.get("x-goog-api-key");
    if (!key && googApiKey) {
        key = googApiKey.trim();
        source = "x-goog-api-key header";
    }
    // 检查 URL 参数
    if (!key) {
        const urlKey = url.searchParams.get("key");
        if (urlKey) {
            key = urlKey.trim();
            source = "URL parameter 'key'";
        }
    }

    return { key, source };
}

// --- 主请求处理函数 ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  
  console.log(`\n[${requestId}] === 收到请求 ===`);
  console.log(`[${requestId}] 方法: ${req.method}`);
  console.log(`[${requestId}] 原始路径: ${url.pathname}`);
  console.log(`[${requestId}] 原始 URL Search: ${url.search}`);

  // --- CORS 预检请求处理 ---
  const originHeader = req.headers.get("origin");
  const allowedOrigin = originHeader || "*"; 

  if (req.method === "OPTIONS") {
    // (这部分代码与原来完全相同)
    console.log(`[${requestId}] 处理 CORS 预检请求 (Origin: ${originHeader})`);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY, Origin, Accept",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // --- 服务器配置检查 ---
  if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
    // (这部分代码与原来完全相同)
    console.error(`[${requestId}] 错误：服务器环境变量 MY_SERVER_SECRET_KEY 或 GEMINI_API_KEYS 未正确配置。`);
    return new Response(JSON.stringify({ error: "服务器配置错误", message: "请检查Deno Deploy中的环境变量设置。" }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin }});
  }

  // --- 1. 验证客户端 (AI软件) 发送的访问密钥 ---
  const { key: clientSecretKey, source: keySource } = getClientSecretKeyFromRequest(req);
  console.log(`[${requestId}] 客户端密钥来源: ${keySource}`);
  if (!clientSecretKey) {
    // (这部分代码与原来完全相同)
    return new Response(JSON.stringify({ error: "认证失败：未提供访问代理密钥" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin }});
  }
  if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
    // (这部分代码与原来完全相同)
    return new Response(JSON.stringify({ error: "认证失败：访问代理的密钥无效" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin }});
  }
  console.log(`[${requestId}] 访问代理认证成功 (密钥来源: ${keySource})`);

  // --- 2. 准备转发给 Gemini API 的请求 ---
  let configuredGeminiApiKey = "";
  try {
    configuredGeminiApiKey = getRandomGeminiApiKey();
  } catch (error) {
    return new Response(JSON.stringify({ error: "服务器内部错误", message: error.message }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin }});
  }
  
  // --- 路径处理逻辑 ---
  let servicePathSegment = url.pathname; 

  // 1. 移除路径开头的多余斜杠
  while (servicePathSegment.startsWith('/')) {
      servicePathSegment = servicePathSegment.substring(1);
  }

  // ------------------- 核心修改点 (开始) -------------------
  // 旧的、有问题的代码:
  // if (servicePathSegment.startsWith('v1/')) {
  //     servicePathSegment = servicePathSegment.substring(3);
  // }
  
  // 新的、已修复的代码:
  // 使用正则表达式匹配 v1/ 或 v1beta/ 并移除，这样更健壮
  const prefixMatch = servicePathSegment.match(/^(v1\/|v1beta\/)/);
  if (prefixMatch) {
      // prefixMatch[0] 会得到匹配到的完整前缀，例如 "v1/" 或 "v1beta/"
      // 然后从原始路径中减去这个前缀的长度
      servicePathSegment = servicePathSegment.substring(prefixMatch[0].length);
      console.log(`[${requestId}] 检测到并移除了 API 版本前缀: "${prefixMatch[0]}"`);
  }
  // ------------------- 核心修改点 (结束) -------------------

  // 3. 最终构建的目标 URL
  const finalTargetUrl = `${GEMINI_API_BASE.replace(/\/v1$/, '')}/${servicePathSegment}${url.search}`;

  console.log(`[${requestId}] 原始 AI软件 路径: ${url.pathname}`);
  console.log(`[${requestId}] 处理后的 Gemini 服务路径: ${servicePathSegment}`);
  
  // Gemini API Key 作为 URL 参数传递
  url.searchParams.delete("key"); 
  url.searchParams.set("key", configuredGeminiApiKey);
  
  const finalUrl = new URL(finalTargetUrl);
  finalUrl.search = url.searchParams.toString();

  console.log(`[${requestId}] 目标 Gemini API URL: ${finalUrl.toString()}`); 

  // --- 准备发送给 Gemini API 的 Headers ---
  const forwardHeaders = new Headers();
  // ... (以下所有代码，包括 Header 转发、请求体处理、fetch请求、响应处理等，都与原来完全相同)
  const headersToExclude = ["host", "authorization", "x-api-key", "x-goog-api-key", "x-por-api-key", "key"];

  for (const [headerName, headerValue] of req.headers.entries()) {
    if (!headersToExclude.some(excluded => headerName.toLowerCase() === excluded)) {
      forwardHeaders.set(headerName, headerValue);
    }
  }

  forwardHeaders.set("Content-Type", req.headers.get("Content-Type") || "application/json");

  // --- 准备请求体 ---
  let requestBodyBuffer: ArrayBuffer | null = req.body ? await req.arrayBuffer() : null;

  // --- 发送请求到 Gemini API ---
  try {
    const geminiResponse = await fetch(finalUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: requestBodyBuffer,
    });
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Gemini API 响应状态: ${geminiResponse.status} (${responseTime}ms)`);
    
    // --- 准备返回给客户端 (AI软件) 的响应 ---
    const responseHeaders = new Headers(geminiResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);

    return new Response(geminiResponse.body, {
      status: geminiResponse.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${requestId}] 请求 Gemini API 时发生网络或fetch错误:`, error);
    return new Response(JSON.stringify({ error: "与 Gemini API 通信时发生错误", message: error.message }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin }});
  }
}

// --- 启动服务器 ---
console.log("Gemini API 代理服务器已启动 (v1beta fix)。");
serve(handler);

