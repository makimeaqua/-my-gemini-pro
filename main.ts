// main.ts (或者您的项目入口文件，确保文件名一致)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// --- 配置 ---
// Gemini API 的基础 URL，注意：已经包含 /v1
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1"; // <-- /v1 已经在这里

// 1. 我的服务器的认证密钥，用于验证谁能访问我的代理 (SillyTavern 发送)
const MY_SERVER_SECRET_KEY = Deno.env.get("MY_SERVER_SECRET_KEY");

// 2. Gemini API 密钥 (可以是一个或多个，用逗号分隔)
const GEMINI_API_KEYS_STR = Deno.env.get("GEMINI_API_KEYS");
let GEMINI_AI_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_AI_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

// --- 日志和启动检查 ---
console.log("========================");
console.log("  Gemini API 代理服务器");
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

// 尝试从 SillyTavern 发送的请求中获取访问代理的密钥
function getClientSecretKeyFromRequest(req: Request): { key: string | undefined, source: string } {
  const url = new URL(req.url);
  const headers = req.headers;
  let key: string | undefined = undefined;
  let source = "未找到";

  // 优先检查 x-por-api-key (CherryStudio 推荐，SillyTavern 也可能发送)
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
  // 允许所有来源，但您也可以限制为特定的 SillyTavern 运行地址
  const allowedOrigin = originHeader || "*"; 

  if (req.method === "OPTIONS") {
    console.log(`[${requestId}] 处理 CORS 预检请求 (Origin: ${originHeader})`);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        // SillyTavern 需要的 Headers，确保包含：
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY, Origin, Accept",
        "Access-Control-Allow-Credentials": "true", // 如果 SillyTavern 使用 cookie 或其他凭证
        "Access-Control-Max-Age": "86400", // 缓存预检结果 24 小时
      },
    });
  }

  // --- 服务器配置检查 ---
  if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
    console.error(`[${requestId}] 错误：服务器环境变量 MY_SERVER_SECRET_KEY 或 GEMINI_API_KEYS 未正确配置。`);
    return new Response(
      JSON.stringify({
        error: "服务器配置错误",
        details: {
          env_configured: {
            MY_SERVER_SECRET_KEY: !!MY_SERVER_SECRET_KEY,
            GEMINI_API_KEYS: GEMINI_AI_KEYS.length > 0
          }},
        message: "请检查Deno Deploy中的环境变量设置。"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, Access-Control-Allow-Origin Source", // 允许客户端读取 Origin
        }
      }
    );
  }

  // --- 1. 验证客户端 (SillyTavern) 发送的访问密钥 ---
  const { key: clientSecretKey, source: keySource } = getClientSecretKeyFromRequest(req);

  console.log(`[${requestId}] 客户端密钥来源: ${keySource}`);

  if (!clientSecretKey) {
    console.log(`[${requestId}] 认证失败：未提供访问代理的密钥`);
    return new Response(
      JSON.stringify({
        error: "认证失败：未提供访问代理密钥",
        hint: "请在 x-por-api-key (推荐), x-api-key, Authorization header, x-goog-api-key 中或 URL 参数 'key' 提供您的密钥。"
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }

  if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
    console.log(`[${requestId}] 认证失败：提供给代理的密钥无效`);
    return new Response(
      JSON.stringify({ error: "认证失败：访问代理的密钥无效" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }
  console.log(`[${requestId}] 访问代理认证成功 (密钥来源: ${keySource})`);

  // --- 2. 准备转发给 Gemini API 的请求 ---
  let configuredGeminiApiKey = "";
  try {
    configuredGeminiApiKey = getRandomGeminiApiKey();
  } catch (error) {
    console.error(`[${requestId}] ${error.message}`);
    return new Response(
      JSON.stringify({ error: "服务器内部错误", message: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }
  
  // --- 路径处理逻辑 ---
  let geminiServicePath = url.pathname; // SillyTavern 发送的原始路径
  
  // 1. 移除路径开头的多余斜杠 (例如，从 "//chat/completions" 变成 "chat/completions")
  while (geminiServicePath.startsWith('/') && geminiServicePath.length > 1) {
      geminiServicePath = geminiServicePath.substring(1);
  }
  // 2. 如果路径是以 "v1/" 开头的，则移除它
  if (geminiServicePath.startsWith('v1/')) {
      geminiServicePath = geminiServicePath.substring(3); // 移除 "v1/"
  }

  // 3. 最终构建的 Gemini API 请求路径，总是以 /v1/ 开头
  //    GEMINI_API_BASE 已经包含了 "/v1"，所以我们只需要加上处理后的剩余路径
  const targetUrl = `${GEMINI_API_BASE}${geminiServicePath ? '/' + geminiServicePath : ''}${url.search}`;

  console.log(`[${requestId}] 原始 SillyTavern 路径: ${url.pathname}`);
  console.log(`[${requestId}] 处理后的 Gemini 服务路径: ${geminiServicePath}`); // 这里输出的是 /chat/completions 或 models (不带/v1)

  // Gemini API Key 作为 URL 参数传递
  // **重点**：移除 URL 中可能存在的旧的 `key` 参数，然后添加新的 Gemini Key
  url.searchParams.delete("key"); 
  url.searchParams.set("key", configuredGeminiApiKey);
  
  // 最终构造的 Gemini API 请求 URL
  // console.log(`[${requestId}] 目标 Gemini API URL: ${targetUrl}`); // 移除了，因为 GEMINI_API_BASE 已经是一个完整 URL
  console.log(`[${requestId}] Gemini API Key Index: ${GEMINI_AI_KEYS.indexOf(configuredGeminiApiKey) + 1}/${GEMINI_AI_KEYS.length}`);

  // --- 准备发送给 Gemini API 的 Headers ---
  const forwardHeaders = new Headers();
  const headersToExclude = [
    "host", "connection", "content-length", "transfer-encoding", "upgrade",
    "sec-websocket-key", "sec-websocket-protocol", "sec-websocket-version", "sec-websocket-extensions", 
    "origin", "access-control-request-headers", "access-control-request-method", 
    "authorization", "x-api-key", "x-goog-api-key", "x-por-api-key", "key" 
  ];

  for (const [headerName, headerValue] of req.headers.entries()) {
    if (
      !headersToExclude.some(excluded => headerName.toLowerCase() === excluded) &&
      headerValue !== null 
    ) {
      forwardHeaders.set(headerName, headerValue);
    }
  }
  
  // 确保 Content-Type 被正确设置
  if (!forwardHeaders.has("Content-Type") && req.headers.get("Content-Type")) {
    forwardHeaders.set("Content-Type", req.headers.get("Content-Type")!);
  } else if (!forwardHeaders.has("Content-Type")) {
      forwardHeaders.set("Content-Type", "application/json"); // 默认 JSON
  }

  // --- 准备请求体 ---
  let requestBodyBuffer: ArrayBuffer | null = null;
  if (req.body) { // 检查 req.body 是否存在
    try {
      requestBodyBuffer = await req.arrayBuffer();
      console.log(`[${requestId}] 请求体大小: ${requestBodyBuffer.byteLength} bytes`);
    } catch (e) {
      console.error(`[${requestId}] 读取请求体时发生错误:`, e);
      // 如果读取请求体失败，也返回错误
      return new Response(
        JSON.stringify({ error: "无法读取请求体", message: e.message }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin } }
      );
    }
  } else {
      console.log(`[${requestId}] 请求无请求体。`);
  }

  // --- 发送请求到 Gemini API ---
  let geminiResponse: Response;
  let responseBodyToReturn: ArrayBuffer | ReadableStream | null = null; // 用于存储最终要返回的响应体
  let consumeError: Error | null = null; // 用于存储读取响应体时可能发生的错误
  let geminiErrorDetails: string | null = null; // 用于存储 Gemini API 返回的错误细节

  try {
    const finalTargetUrl = `${GEMINI_API_BASE}${geminiServicePath}${url.search}`; // 构造最终 URL
    console.log(`[${requestId}] 发送请求到 Gemini API: ${req.method} ${finalTargetUrl}`);

    geminiResponse = await fetch(finalTargetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: requestBodyBuffer ? requestBodyBuffer : undefined,
    });
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Gemini API 响应状态: ${geminiResponse.status} (${responseTime}ms)`);

    // 检查 Gemini API 的响应状态码
    if (geminiResponse.status >= 400) {
        try {
            // **!!! 关键更改 !!!**
            // 使用 clone() 来创建一个响应的副本，这样我们就可以安全地读取它，
            // 而不会“消耗”原始的 geminiResponse，以便后续的流式/非流式处理。
            const errorResponseClone = geminiResponse.clone(); 
            const errorBody = await errorResponseClone.text();
            geminiErrorDetails = `Status ${geminiResponse.status}, Response: "${errorBody.substring(0, 500)}"`;
            console.error(`[${requestId}] Gemini API 错误详情: ${geminiErrorDetails}`);
        } catch (e) {
            geminiErrorDetails = `Status ${geminiResponse.status}, Body size: ${geminiResponse.headers.get("content-length") || "unknown"} (unable to read text)`;
            console.error(`[${requestId}] Gemini API 错误响应 (无法读取文本): ${geminiErrorDetails}`);
        }
    }

  } catch (error) {
    console.error(`[${requestId}] 请求 Gemini API 时发生网络或fetch错误:`, error);
    return new Response(
      JSON.stringify({
        error: "与 Gemini API 通信时发生错误",
        message: error instanceof Error ? error.message : "未知错误",
        targetUrl: `https://generativelanguage.googleapis.com/v1${geminiServicePath}${url.search}` // 包含目标 URL 方便调试
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }

  // --- 准备返回给客户端 (SillyTavern) 的响应 ---
  // 复制 Gemini API 的响应头，并添加 CORS 和调试信息
  const responseHeaders = new Headers();
  const headersToReturn = [
    "Content-Type", "Cache-Control", "Content-Encoding", "Transfer-Encoding",
    "Date", "Server", "Content-Length" // 复制一些标准的响应头
  ];
  for (const header of headersToReturn) {
    const value = geminiResponse.headers.get(header);
    if (value !== null && value !== undefined) {
      responseHeaders.set(header, value);
    }
  }
  
  // 添加 CORS Headers
  responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
  responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY");
  responseHeaders.set("Access-Control-Allow-Credentials", "true");

  // 添加调试 Headers
  responseHeaders.set("X-Request-ID", requestId);
  responseHeaders.set("X-Gemini-API-Key-Index", `${GEMINI_AI_KEYS.indexOf(configuredGeminiApiKey) + 1}/${GEMINI_AI_KEYS.length}`);

  // --- 确定是流式还是非流式响应 ---
  // Gemini API chat completions 响应通常是 SSE stream (Content-Type: text/event-stream)
  // 但有时即使 Content-Type 不是 event-stream，也可能返回 chunked 响应，表现为流式。
  // 结合 Content-Type 和 Transfer-Encoding (chunked) 可以更准确地判断。
  const contentType = geminiResponse.headers.get("Content-Type");
  const transferEncoding = geminiResponse.headers.get("Transfer-Encoding");
  // 即使 Status >= 400，它仍然可能是流式错误信息 (例如，Gemini API 返回的SSE错误)
  // 并且，如果 Content-Type 不是 application/json 并且不是 text/html (通常是错误页面)，也倾向认为是流式
  const isStreaming = 
    contentType?.includes("event-stream") || 
    transferEncoding === "chunked" ||
    (geminiResponse.status < 400 && !(contentType && contentType.startsWith("application/json"))) || // 成功响应，且非 JSON，认为是流式
    (geminiResponse.status >= 400 && !(contentType && contentType.startsWith("application/json")) && !contentType?.includes("html")); // 错误响应，但 Content-Type 不是 JSON 也不是 HTML，可能是 SSE 错误


  try {
      if (isStreaming) {
          console.log(`[${requestId}] 检测到流式响应 (CT: ${contentType}, TE: ${transferEncoding}), 正在处理...`);
          responseHeaders.set("Content-Type", "text/event-stream"); // 明确设置为 SSE
          responseHeaders.set("Cache-Control", "no-cache"); // 缓存控制
          responseHeaders.set("Connection", "keep-alive"); // 保持连接

          // **!!! 关键更改 !!!**
          // 对于流式响应，直接返回 geminiResponse.body (ReadableStream)
          // 确保这个 body 没有在其他地方被消耗
          responseBodyToReturn = geminiResponse.body; 

      } else {
          // --- 处理非流式响应 ---
          console.log(`[${requestId}] 检测到非流式响应 (CT: ${contentType || 'N/A'}, TE: ${transferEncoding})`);
          
          // 如果 Gemini API 返回了错误 (status >= 400) 并且我们已经获取了错误详情 (geminiErrorDetails)
          // 此时，我们应该返回一个标准的 JSON 错误响应，而不是尝试读取已消耗的 body
          if (geminiResponse.status >= 400 && geminiErrorDetails) {
              const errorPayload = JSON.stringify({
                  error: "Gemini API 返回错误",
                  details: geminiErrorDetails,
                  requestId: requestId,
              });
              responseHeaders.set("Content-Type", "application/json");
              responseBodyToReturn = new TextEncoder().encode(errorPayload); // 将错误信息编码为 ArrayBuffer
              return new Response(responseBodyToReturn, {
                  status: geminiResponse.status, // 使用 Gemini API 返回的状态码
                  headers: responseHeaders,
              });

          } else if (geminiResponse.status < _400) { // 修正 typo 
              // **!!! 关键更改 !!!**
              // 仅在非流式、非错误响应时，第一次（也是唯一一次）调用 arrayBuffer()
              responseBodyToReturn = await geminiResponse.arrayBuffer();
              console.log(`[${requestId}] 非流式响应体: ${(<ArrayBuffer>responseBodyToReturn).byteLength} bytes`);
          } else {
              // 理论上，如果 status < 400 且不是流式，一定会走 arrayBuffer()
              // 如果走到这里，可能是一个罕见的逻辑分支，输出警告
              console.warn(`[${requestId}] **警告：** 遇到未知非流式响应处理情况 (Status: ${geminiResponse.status}, CT: ${contentType})`);
              // 尝试读取，以防万一
              responseBodyToReturn = await geminiResponse.arrayBuffer();
              console.log(`[${requestId}] 非流式响应体 (尝试读取): ${(<ArrayBuffer>responseBodyToReturn).byteLength} bytes`);
          }
      }
      
  } catch (e) {
      console.error(`[${requestId}] 处理 Gemini API 响应时发生错误 (读取body):`, e);
      consumeError = e; // 记录错误
  }

  // --- 返回最终响应 ---
  if (consumeError) {
    // 如果在 try-catch 块中读取响应体时发生错误，返回内部服务器错误
    return new Response(
        JSON.stringify({ 
            error: "服务器内部错误 - 无法处理 Gemini API 响应", 
            message: consumeError.message,
            requestId: requestId,
            geminiErrorDetails: geminiErrorDetails // 包含之前获取的 Gemini 错误信息
        }),
        { 
            status: 500, 
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin } 
        }
    );
  }

  // !!! 确保 responseBodyToReturn 非空 !!!
  if (!responseBodyToReturn) {
    console.error(`[${requestId}] **致命错误：** responseBodyToReturn 为空！`);
    return new Response(
        JSON.stringify({ error: "服务器内部错误 - 响应体生成失败", requestId: requestId }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin } }
    );
  }
  
  // 如果是流式，responseBodyToReturn 是 ReadableStream
  // 如果是非流式，responseBodyToReturn 是 ArrayBuffer
  return new Response(responseBodyToReturn, {
    status: geminiResponse.status,
    headers: responseHeaders,
  });
}

// --- 启动服务器 ---
console.log("Gemini API 代理服务器已启动。");
serve(handler); // Deno Deploy 会自动处理端口和监听
