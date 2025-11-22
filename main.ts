// main.ts (最终完美版：简化逻辑，正确转发路径)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// --- 配置 ---
// 1. Gemini API 的基础 URL，注意：这里不包含任何版本号
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// 2. 我的服务器的认证密钥
const MY_SERVER_SECRET_KEY = Deno.env.get("MY_SERVER_SECRET_KEY");

// 3. Gemini API 密钥
const GEMINI_API_KEYS_STR = Deno.env.get("GEMINI_API_KEYS");
let GEMINI_AI_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_AI_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

// (为了简洁，省略了与之前相同的启动检查等辅助函数，下面的代码块是完整的，可以直接复制使用)
// --- 日志和启动检查 ---
console.log("========================");
console.log("  Gemini API 代理服务器 (perfect-final-fix)");
console.log("========================");
if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
  console.error("\n!!! 启动失败：环境变量 MY_SERVER_SECRET_KEY 或 GEMINI_API_KEYS 未正确配置 !!!\n");
} else {
  console.log("服务器配置检查通过。");
}
console.log("========================");


// 随机选择一个 Gemini API Key
function getRandomGeminiApiKey(): string {
  if (GEMINI_AI_KEYS.length === 0) throw new Error("Gemini API Key 列表为空。");
  const randomIndex = Math.floor(Math.random() * GEMINI_AI_KEYS.length);
  return GEMINI_AI_KEYS[randomIndex];
}

// 尝试从请求中获取访问代理的密钥
function getClientSecretKeyFromRequest(req: Request): string | undefined {
    const headers = req.headers;
    // 优先检查 Authorization: Bearer <key>
    const authHeader = headers.get("Authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        return authHeader.substring(7).trim();
    }
    // 检查其他常见的 header
    return headers.get("x-goog-api-key") || headers.get("x-api-key") || undefined;
}


// --- 主请求处理函数 ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  
  console.log(`\n[${requestId}] === 收到请求: ${req.method} ${url.pathname} ===`);

  const originHeader = req.headers.get("origin") || "*";

  // --- CORS 预检请求处理 ---
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": originHeader,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key",
      },
    });
  }

  // --- 认证和配置检查 ---
  if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
    return new Response(JSON.stringify({ error: "服务器配置错误" }), { status: 500 });
  }
  const clientSecretKey = getClientSecretKeyFromRequest(req);
  if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
    console.log(`[${requestId}] 认证失败: 客户端密钥无效或未提供。`);
    return new Response(JSON.stringify({ error: "认证失败" }), { status: 401 });
  }
  console.log(`[${requestId}] 代理认证成功。`);

  // --- 核心URL构建逻辑 (最终版) ---
  // 直接将 Google 域名和客户端请求的完整路径拼接起来
  const finalTargetUrl = `${GEMINI_API_BASE}${url.pathname}`;
  
  const finalUrl = new URL(finalTargetUrl);
  // 继承客户端的所有查询参数
  finalUrl.search = url.search; 
  // 关键：将我们的 Gemini API Key 添加为 `key` 参数
  finalUrl.searchParams.set("key", getRandomGeminiApiKey());

  console.log(`[${requestId}] 目标 Gemini API URL: ${finalUrl.toString()}`); 

  // --- 转发请求 ---
  const forwardHeaders = new Headers(req.headers);
  // 删除客户端用于代理认证的 header，避免发送给Google
  forwardHeaders.delete("authorization");
  forwardHeaders.delete("x-api-key");
  forwardHeaders.delete("x-goog-api-key");

  try {
    const geminiResponse = await fetch(finalUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.body,
    });
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Gemini API 响应状态: ${geminiResponse.status} (${responseTime}ms)`);
    
    // 构造返回给客户端的响应
    const responseHeaders = new Headers(geminiResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", originHeader);
    return new Response(geminiResponse.body, { status: geminiResponse.status, headers: responseHeaders });

  } catch (error) {
    console.error(`[${requestId}] 请求 Gemini API 时发生网络或fetch错误:`, error);
    return new Response(JSON.stringify({ error: "与 Gemini API 通信时发生错误"}), { status: 502 });
  }
}

// --- 启动服务器 ---
console.log("Gemini API 代理服务器已启动 (perfect-final-fix)。");
serve(handler);
