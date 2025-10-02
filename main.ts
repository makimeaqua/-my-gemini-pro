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
console.log(`MY_SERVER_SECRET_KEY: ${MY_SERVER_SECRET_KEY ? `[${MY_SERVER_SECRET_KEY.length} 字符]` : '未设置'}`);
console.log(`Gemini API Keys 数量: ${GEMINI_AI_KEYS.length}`);
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

// --- handler 函数 ---
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
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    // ----- 环境变量检查 -----
    if (!MY_SERVER_SECRET_KEY) {
      console.error(`[${requestId}] 错误：环境变量 'MY_SERVER_SECRET_KEY' 未设置`);
      return new Response(
        JSON.stringify({ 
          error: "服务器配置错误",
          details: { env_configured: { MY_SERVER_SECRET_KEY: false }}
        }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    if (GEMINI_AI_KEYS.length === 0) {
      console.error(`[${requestId}] 错误：环境变量 'GEMINI_API_KEYS' 未设置或为空`);
      return new Response(
        JSON.stringify({ 
          error: "服务器配置错误",
          details: { env_configured: { GEMINI_API_KEYS: false }}
        }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    // ----- 环境变量检查结束 -----

    // ----- 1. 验证客户端发送的密钥 (用于访问你的代理) -----
    let clientSecretKey = "";
    let keySource = ""; // 记录密钥从哪里获取
    let foundClientKey = false;
    
    // 按照优先级从 Headers 和QueryParams中查找客户端密钥
    const headersToTry = ["x-por-api-key", "x-goog-api-key", "Authorization", "x-api-key"];
    
    // 尝试 Header
    for (const headerName of headersToTry) {
      const value = req.headers.get(headerName);
      if (value) {
        clientSecretKey = value.trim();
        keySource = `${headerName} header`;
        foundClientKey = true;
        if (headerName === "Authorization" && clientSecretKey.toLowerCase().startsWith("bearer ")) {
          clientSecretKey = clientSecretKey.substring(7).trim(); // 提取 bearer token
          keySource = "Authorization Bearer";
        }
        break; // 找到后就停止往下找
      }
    }
    
    // 如果在 Header 中没有找到，尝试 URL 参数
    if (!foundClientKey) {
      const urlKey = url.searchParams.get("key");
      if (urlKey) {
        clientSecretKey = urlKey.trim();
        keySource = "URL parameter";
        foundClientKey = true;
      }
    }

    console.log(`[${requestId}] ----- 客户端密钥捕获 -----`);
    console.log(`[${requestId}] 客户端密钥来源: ${keySource || '未找到'}`);
    if (foundClientKey) {
        console.log(`[${requestId}] 捕获到的客户端密钥 (前8位): ${clientSecretKey.substring(0, 8)}${clientSecretKey.length > 8 ? '...' : ''}`);
    } else {
        console.log(`[${requestId}] 未在任何 Header 或 URL 参数中找到客户端密钥`);
    }
    console.log(`[${requestId}] ---------------------------`);
    
    // 检查是否找到了客户端密钥
    if (!foundClientKey) {
      console.log(`[${requestId}] 认证失败：未提供访问代理的密钥 (“${keySource || '未知'}” )`);
      return new Response(
        JSON.stringify({ 
          error: "认证失败：未提供访问代理的密钥",
          hint: "请在 x-por-api-key (推荐), x-goog-api-key, Authorization header, x-api-key 中或 URL 参数 'key' 提供密钥"
        }),
        { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    
    // 比较客户端密钥和服务端密钥
    if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
      console.log(`[${requestId}] 认证失败：提供的访问代理密钥不匹配`);
      return new Response(
        JSON.stringify({ error: "认证失败：访问代理的密钥无效" }),
        { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    console.log(`[${requestId}] 访问代理认证成功`);
    // ----- 客户端密钥验证结束 -----


    // ----- 2. 准备转发给 Gemini API 的请求 -----
    const selectedGeminiApiKey = getRandomGeminiApiKey();
    const keyIndex = GEMINI_AI_KEYS.indexOf(selectedGeminiApiKey) + 1;
    
    const targetPath = url.pathname;
    // 移除URL中可能带有的key参数，防止干扰
    url.searchParams.delete("key"); 
    // **重点：** 将 Gemini API Key 添加到 URL 的 `key` 参数中
    url.searchParams.set("key", selectedGeminiApiKey); 
    const targetUrl = `${GEMINI_API_BASE}${targetPath}${url.search}`;
    
    console.log(`[${requestId}] 转发请求到 Gemini API: ${targetPath}`);

    // 准备发送给 Gemini API 的 Headers
    const forwardHeaders = new Headers();
    const headersToForward = [
      "Content-Type", "Accept", "User-Agent", "Accept-Language", 
      "Accept-Encoding", "x-goog-api-client", "X-User-IP"
    ];
    
    for (const header of headersToForward) {
      const value = req.headers.get(header);
      if (value) {
        forwardHeaders.set(header, value);
      }
    }

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
      "Date", "Server",
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
