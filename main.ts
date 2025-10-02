import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// --- 配置 ---
// 1. 我的服务器的认证密钥，用于验证谁能访问我的代理
const MY_SERVER_SECRET_KEY = Deno.env.get("MY_SERVER_SECRET_KEY"); 

// 2. Gemini API 密钥 (可以是一个或多个，用逗号分隔)
const GEMINI_API_KEYS_STR = Deno.env.get("GEMINI_API_KEYS"); 
let GEMINI_AI_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_AI_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

// --- 日志和启动检查 ---
console.log("=== 服务器启动配置检查 ===");
console.log(`MY_SERVER_SECRET_KEY 是否已设置: ${MY_SERVER_SECRET_KEY ? '是' : '否'}`);
console.log(`Gemini API Keys (${GEMINI_API_KEYS_STR ? '包含' : '不包含'}): ${GEMINI_AI_KEYS.length} 个`);
if (GEMINI_AI_KEYS.length > 0) {
  console.log(`Gemini API Keys 长度分布: ${GEMINI_AI_KEYS.map(k => k.length).join(', ')}`);
}
console.log("========================");

// 随机选择一个 Gemini API Key
function getRandomGeminiApiKey(): string {
  if (GEMINI_AI_KEYS.length === 0) {
    throw new Error("没有可用的 Gemini API Key，请检查环境变量 'GEMINI_API_KEYS'");
  }
  const randomIndex = Math.floor(Math.random() * GEMINI_AI_KEYS.length);
  const selectedKey = GEMINI_AI_KEYS[randomIndex];
  console.log(`选择 Gemini API Key #${randomIndex + 1}/${GEMINI_AI_KEYS.length}`);
  return selectedKey;
}

// ... handler 函数 ...
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  
  console.log(`\n[${requestId}] === 收到请求 ===`);
  console.log(`[${requestId}] 方法: ${req.method}`);
  console.log(`[${requestId}] 路径: ${url.pathname}`);
  
  // CORS 预检请求
  if (req.method === "OPTIONS") {
    console.log(`[${requestId}] 处理 OPTIONS 预检请求`);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        // 确保 client 发送的 header 都有被允许
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    // 检查服务器端配置
    if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
      console.error(`[${requestId}] 错误：服务器环境变量未正确配置`);
      return new Response(
        JSON.stringify({ 
          error: "服务器配置错误",
          details: { env_configured: {
            MY_SERVER_SECRET_KEY: !!MY_SERVER_SECRET_KEY,
            GEMINI_API_KEYS: GEMINI_AI_KEYS.length > 0
          }}
        }),
        { 
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        }
      );
    }

    // 1. 验证客户端发送的密钥 (用于访问你的代理)
    let clientSecretKey = "";
    let keySource = "";
    
    // 尝试从 x-por-api-key header 获取 (这是 CherryStudio 发送的)
    const porApiKey = req.headers.get("x-por-api-key");
    if (porApiKey) {
      clientSecretKey = porApiKey.trim();
      keySource = "x-por-api-key header";
    }
    // 如果没有，尝试其他 header 或 URL 参数... (按照你的客户端可能发送的顺序)
    if (!clientSecretKey) { // 检查 x-goog-api-key
        const googApiKey = req.headers.get("x-goog-api-key");
        if (googApiKey) {
            clientSecretKey = googApiKey.trim();
            keySource = "x-goog-api-key header";
        }
    }
    if (!clientSecretKey) { // 检查 Authorization
        const authHeader = req.headers.get("Authorization");
        if (authHeader) {
            if (authHeader.toLowerCase().startsWith("bearer ")) {
                clientSecretKey = authHeader.substring(7).trim();
                keySource = "Authorization Bearer";
            } else {
                clientSecretKey = authHeader.trim();
                keySource = "Authorization (direct)";
            }
        }
    }
     if (!clientSecretKey) { // 检查 x-api-key
        const xApiKey = req.headers.get("x-api-key");
        if (xApiKey) {
            clientSecretKey = xApiKey.trim();
            keySource = "x-api-key header";
        }
    }
    if (!clientSecretKey) { // 检查 URL 参数 key
      const urlKey = url.searchParams.get("key");
      if (urlKey) {
        clientSecretKey = urlKey.trim();
        keySource = "URL parameter";
      }
    }

    console.log(`[${requestId}] 客户端密钥来源: ${keySource || '未找到'}`);
    
    if (!clientSecretKey) {
      console.log(`[${requestId}] 认证失败：未提供访问代理的密钥`);
      return new Response(
        JSON.stringify({ 
          error: "认证失败：未提供访问代理的密钥",
          hint: "请在 x-por-api-key (推荐), x-goog-api-key, Authorization header, x-api-key 中或 URL 参数 'key' 提供密钥"
        }),
        { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    
    if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
      console.log(`[${requestId}] 认证失败：访问代理的密钥不匹配`);
      return new Response(
        JSON.stringify({ error: "认证失败：访问代理的密钥无效" }),
        { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    console.log(`[${requestId}] 访问代理认证成功`);

    // 2. 准备转发给 Gemini API 的请求
    const selectedGeminiApiKey = getRandomGeminiApiKey();
    const keyIndex = GEMINI_AI_KEYS.indexOf(selectedGeminiApiKey) + 1;
    
    const targetPath = url.pathname;
    // 移除URL中可能带有的key参数，防止干扰
    url.searchParams.delete("key"); 
    // **重点：** 将 Gemini API Key 添加到 URL 的 `key` 参数中，这是 Gemini API 的标准做法
    url.searchParams.set("key", selectedGeminiApiKey); 
    const targetUrl = `${GEMINI_API_BASE}${targetPath}${url.search}`;
    
    console.log(`[${requestId}] 转发请求到 Gemini API: ${targetPath}`);

    // 准备发送给 Gemini API 的 Headers
    const forwardHeaders = new Headers();
    const headersToForward = [
      "Content-Type", "Accept", "User-Agent", "Accept-Language", 
      "Accept-Encoding", "x-goog-api-client", "X-User-IP" // 加上 X-User-IP 可能会有帮助
    ];
    
    for (const header of headersToForward) {
      const value = req.headers.get(header);
      if (value) {
        forwardHeaders.set(header, value);
      }
    }
    // **重要：** 确保 `x-por-api-key` 或 `x-goog-api-key` 这些 header **不被转发**给 Gemini API，
    // 因为我们已经把 Gemini Key 放在了 URL 参数里。Gemini API 期望 Key 在 URL 参数 `key=` 或
    // header `x-goog-api-key` (如果使用 gcloud CLI 的话)，但这里我们只用 URL 参数。

    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
      console.log(`[${requestId}] 请求体大小: ${body.byteLength} bytes`);
    }

    // 发送请求到 Gemini API
    const startTime = Date.now();
    const geminiResponse = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: body ? body : undefined,
    });
    const responseTime = Date.now() - startTime;

    console.log(`[${requestId}] Gemini 响应: ${geminiResponse.status} (${responseTime}ms)`);
    
    // 准备返回给客户端的 Headers
    const responseHeaders = new Headers();
    const headersToReturn = [
      "Content-Type", "Content-Length", "Content-Encoding", "Transfer-Encoding",
      "Date", "Server", // 复制一些标准的响应头
    ];
    for (const header of headersToReturn) {
      const value = geminiResponse.headers.get(header);
      if (value) {
        responseHeaders.set(header, value);
      }
    }
    
    // 添加 CORS 和调试 Headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("X-Request-ID", requestId);
    responseHeaders.set("X-Gemini-API-Config", `Key #${keyIndex}/${GEMINI_AI_KEYS.length}`); 
    
    // 处理流式响应
    const contentType = geminiResponse.headers.get("Content-Type");
    if (contentType?.includes("stream") || url.searchParams.get("alt") === "sse") {
      console.log(`[${requestId}] 返回流式响应`);
      return new Response(geminiResponse.body, {
        status: geminiResponse.status,
        headers: responseHeaders,
      });
    }

    // 非流式响应
    const responseBody = await geminiResponse.arrayBuffer();
    console.log(`[${requestId}] 响应体大小: ${responseBody.byteLength} bytes`);
    
    if (geminiResponse.status >= 400) {
      try {
        const errorText = new TextDecoder().decode(responseBody);
        console.error(`[${requestId}] Gemini API 错误响应: ${errorText.substring(0, 500)}`);
      } catch (decodeError) {
        console.error(`[${requestId}] Gemini API 错误响应 (无法解码): ${responseBody.byteLength} bytes`);
      }
    }
    
    return new Response(responseBody, {
      status: geminiResponse.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${requestId}] 处理请求时发生全局错误:`, error);
    return new Response(
      JSON.stringify({ 
        error: "内部服务器错误",
        message: error instanceof Error ? error.message : "未知错误",
        requestId: requestId,
      }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      }
    );
  }
}

console.log("Gemini API 代理服务器已启动...");
serve(handler);
