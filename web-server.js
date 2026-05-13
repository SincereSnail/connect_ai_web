const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4825);
const DATA_DIR = path.join(ROOT, "web-data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const COMPANY_PATH = path.join(DATA_DIR, "company.json");

const DEFAULT_CONFIG = {
  ollamaUrl: "http://127.0.0.1:11434",
  lmStudioUrl: "http://127.0.0.1:1234",
  defaultModel: "",
  requestTimeout: 300000,
  workspaceRoot: path.dirname(ROOT),
  localBrainPath: path.join(DATA_DIR, "brain")
};

const clients = new Set();
let chatHistory = loadJson(HISTORY_PATH, []);
let companyConfig = loadJson(COMPANY_PATH, {});
let lastPrompt = "";
let lastModel = "";
let abortController = null;

const AGENTS = [
  { id: "ceo", name: "CEO", role: "Chief Executive Agent", emoji: "🧭", color: "#F8FAFC", tagline: "회사 전체 의사결정과 작업 분배를 맡습니다" },
  { id: "youtube", name: "레오", role: "Head of YouTube", emoji: "📺", color: "#FF4444", tagline: "유튜브 채널 기획과 운영을 책임집니다" },
  { id: "instagram", name: "Instagram", role: "Head of Instagram", emoji: "📷", color: "#E1306C", tagline: "인스타 콘텐츠와 참여 전략을 끌어올립니다" },
  { id: "designer", name: "Designer", role: "Lead Designer", emoji: "🎨", color: "#A78BFA", tagline: "브랜드와 시각 자산 디자인을 담당합니다" },
  { id: "developer", name: "Developer", role: "Lead Engineer", emoji: "💻", color: "#22D3EE", tagline: "코드와 자동화 스크립트를 작성합니다" },
  { id: "business", name: "Business", role: "Head of Business", emoji: "💰", color: "#F5C518", tagline: "수익화, 가격, 전략 의사결정을 봅니다" },
  { id: "secretary", name: "영숙", role: "비서 · Personal Assistant", emoji: "📱", color: "#84CC16", tagline: "일정, 할 일, 보고를 정리합니다" },
  { id: "editor", name: "Editor", role: "Video & Content Editor", emoji: "✂️", color: "#F472B6", tagline: "영상 편집 방향과 콘텐츠를 다듬습니다" },
  { id: "writer", name: "Writer", role: "Copywriter", emoji: "✍️", color: "#FBBF24", tagline: "카피, 스크립트, 후크를 글로 풀어냅니다" },
  { id: "researcher", name: "Researcher", role: "Trend & Data Researcher", emoji: "🔍", color: "#60A5FA", tagline: "트렌드와 데이터를 모아 사실 확인까지 돕습니다" }
];

ensureDir(DATA_DIR);
ensureDir(DEFAULT_CONFIG.localBrainPath);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function getConfig() {
  return { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
}

function getCompanyDir() {
  return path.join(getConfig().localBrainPath, "_company");
}

function companyState(extra = {}) {
  const dir = getCompanyDir();
  return {
    type: "corporateState",
    configured: !!companyConfig.configured,
    companyName: companyConfig.companyName || "",
    companyDir: dir,
    folderExists: fs.existsSync(dir),
    brainExplicitlySet: true,
    companyDay: 1,
    ...extra
  };
}

function ensureCompanyStructure() {
  const dir = getCompanyDir();
  for (const rel of ["_shared", "_agents", "sessions"]) {
    ensureDir(path.join(dir, rel));
  }
  return dir;
}

function saveCompanyConfig(next) {
  companyConfig = { ...companyConfig, ...next };
  saveJson(COMPANY_PATH, companyConfig);
}

function postCorporateReady() {
  const dir = ensureCompanyStructure();
  post({
    type: "corporateReady",
    agents: AGENTS,
    companyDir: dir,
    configured: !!companyConfig.configured,
    companyName: companyConfig.companyName || "",
    folderExists: true,
    brainExplicitlySet: true,
    companyDay: 1
  });
}

function post(type, value) {
  const data = JSON.stringify(typeof type === "object" ? type : { type, value });
  for (const res of [...clients]) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isBuffer ? "application/octet-stream" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(isBuffer ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".md": "text/markdown; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function extractOriginalWebviewHtml() {
  const bundle = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const marker = "_getHtml() {";
  const methodAt = bundle.lastIndexOf(marker);
  if (methodAt < 0) throw new Error("원본 webview HTML을 찾지 못했습니다.");
  const returnAt = bundle.indexOf("return `", methodAt);
  if (returnAt < 0) throw new Error("원본 webview return template을 찾지 못했습니다.");
  const start = returnAt + "return `".length;
  let escaped = false;
  let end = -1;
  for (let i = start; i < bundle.length; i++) {
    const ch = bundle[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("원본 webview HTML 끝을 찾지 못했습니다.");
  const raw = bundle.slice(start, end);
  const html = Function(`"use strict"; return \`${raw}\`;`)();
  return adaptHtmlForWeb(html);
}

function adaptHtmlForWeb(html) {
  const bridge = `
<script>
window.__CONNECT_AI_WEB__ = true;
(function(){
  const queue = [];
  let eventStreamOpen = false;
  function sendMessage(message){
    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message || {})
    }).catch(err => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'error',
        value: '웹 어댑터 연결 실패: ' + err.message
      }}));
    });
  }
  window.acquireVsCodeApi = function(){
    return {
      postMessage(message){
        if (!eventStreamOpen) queue.push(message || {});
        else sendMessage(message);
      },
      getState(){ return JSON.parse(localStorage.getItem('connect-ai-state') || '{}'); },
      setState(state){ localStorage.setItem('connect-ai-state', JSON.stringify(state || {})); }
    };
  };
  const es = new EventSource('/api/events');
  es.onopen = () => {
    eventStreamOpen = true;
    while (queue.length) sendMessage(queue.shift());
  };
  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    } catch (err) {
      console.error('[Connect AI web] bad event', err);
    }
  };
  es.onerror = () => console.warn('[Connect AI web] event stream reconnecting...');
})();
</script>`;
  let out = html.replace(
    /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/i,
    ""
  );
  out = out.replace(
    /function showCorpGate\(onUnlock\)\{[\s\S]*?\n\}\n\nfunction runCorporateClick\(\)\{/,
    `function showCorpGate(onUnlock){
  /* Web build: enter AI Solopreneur mode without the old 4-digit access gate. */
  corporateUnlocked = true;
  if (typeof onUnlock === 'function') onUnlock();
}

function runCorporateClick(){`
  );
  out = out.replace(/vscode-resource:\/\//g, "/");
  out = out.replace(/src="[^"]*\/assets\//g, 'src="/assets/');
  out = out.replace(/url\(['"]?[^'")]*\/assets\//g, "url('/assets/");
  out = out.replace("</head>", `${bridge}\n</head>`);
  out = out.replace(/const vscode=acquireVsCodeApi\(\)/, "const vscode=acquireVsCodeApi()");
  return out;
}

async function detectModels() {
  const cfg = getConfig();
  const lm = await fetchJson(`${cfg.lmStudioUrl}/v1/models`, 1500).catch(() => null);
  if (lm?.data?.length) {
    return {
      engine: "LM Studio",
      baseUrl: cfg.lmStudioUrl,
      models: lm.data.map((m) => m.id).filter(Boolean)
    };
  }
  const ollama = await fetchJson(`${cfg.ollamaUrl}/api/tags`, 1500).catch(() => null);
  if (ollama?.models?.length) {
    return {
      engine: "Ollama",
      baseUrl: cfg.ollamaUrl,
      models: ollama.models.map((m) => m.name).filter(Boolean)
    };
  }
  return {
    engine: "None",
    baseUrl: cfg.ollamaUrl,
    models: cfg.defaultModel ? [cfg.defaultModel] : []
  };
}

async function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function workspaceContext() {
  const root = getConfig().workspaceRoot;
  const candidates = [
    "package.json",
    "README.md",
    "readme.md",
    "index.html",
    "src/main.ts",
    "src/main.tsx",
    "src/App.tsx",
    "main.js"
  ];
  let output = "";
  for (const rel of candidates) {
    const file = path.join(root, rel);
    if (!isInside(root, file) || !fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.length <= 6000) {
        output += `\n\n[파일 내용: ${rel}]\n\`\`\`\n${text}\n\`\`\``;
      }
    } catch {
    }
  }
  return output;
}

function systemPrompt() {
  return `당신은 Connect AI LAB 웹 버전입니다.
로컬 Ollama 또는 LM Studio 모델로 동작하며, 사용자의 프로젝트를 돕는 코딩/기획 에이전트입니다.
필요하면 아래 액션 태그를 답변에 포함할 수 있습니다.
<create_file path="상대경로">파일 내용</create_file>
<edit_file path="상대경로"><find>기존 텍스트</find><replace>새 텍스트</replace></edit_file>
<run_command>실행할 명령</run_command>
웹 버전에서는 모든 경로가 설정된 workspaceRoot 안에서만 실행됩니다.`;
}

async function handlePrompt(message) {
  const prompt = String(message.value || "").trim();
  if (!prompt) return;
  lastPrompt = prompt;
  lastModel = message.model || "";
  const cfg = getConfig();
  const detected = await detectModels();
  const isLMStudio = detected.engine === "LM Studio";
  const model = message.model || cfg.defaultModel || detected.models[0];
  if (!model) {
    post("error", "설치되거나 로드된 로컬 모델을 찾지 못했습니다. Ollama 또는 LM Studio 서버를 켠 뒤 다시 시도해 주세요.");
    return;
  }

  const messages = [
    { role: "system", content: `${systemPrompt()}\n${workspaceContext()}` },
    ...chatHistory,
    { role: "user", content: prompt }
  ];
  chatHistory.push({ role: "user", content: prompt });
  saveJson(HISTORY_PATH, chatHistory);
  post("streamStart");
  abortController = new AbortController();

  let ai = "";
  try {
    const url = isLMStudio
      ? `${detected.baseUrl}/v1/chat/completions`
      : `${detected.baseUrl}/api/chat`;
    const body = isLMStudio
      ? { model, messages, stream: true, max_tokens: 4096, temperature: 0.3 }
      : { model, messages, stream: true, options: { num_ctx: 8192, num_predict: 2048, temperature: 0.3 } };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal
    });
    if (!res.ok) throw new Error(`${detected.engine} HTTP ${res.status}: ${await res.text()}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        const raw = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
        try {
          const json = JSON.parse(raw);
          const token = isLMStudio
            ? json.choices?.[0]?.delta?.content || ""
            : json.message?.content || "";
          if (token) {
            ai += token;
            post("streamChunk", token);
          }
        } catch {
        }
      }
    }
    const report = await executeActions(ai);
    if (report.length) {
      const reportText = `\n\n---\n**에이전트 작업 결과**\n${report.join("\n")}`;
      ai += reportText;
      post("streamChunk", reportText);
    }
    chatHistory.push({ role: "assistant", content: stripActionTags(ai) });
    chatHistory = chatHistory.slice(-24);
    saveJson(HISTORY_PATH, chatHistory);
    post("streamEnd");
  } catch (err) {
    post("error", `오류: ${err.message || err}`);
  } finally {
    abortController = null;
  }
}

function stripActionTags(text) {
  return String(text || "")
    .replace(/<create_file\s+path="[^"]+">[\s\S]*?<\/create_file>/g, "")
    .replace(/<edit_file\s+path="[^"]+">[\s\S]*?<\/edit_file>/g, "")
    .replace(/<run_command>[\s\S]*?<\/run_command>/g, "")
    .trim();
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function countMarkdownFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) count += countMarkdownFiles(p);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

async function executeActions(text) {
  const cfg = getConfig();
  const root = path.resolve(cfg.workspaceRoot || ROOT);
  ensureDir(root);
  const report = [];
  let match;

  const createRe = /<create_file\s+path="([^"]+)">([\s\S]*?)<\/create_file>/g;
  while ((match = createRe.exec(text))) {
    const rel = match[1].trim();
    const target = path.resolve(root, rel);
    if (!isInside(root, target)) {
      report.push(`- 생성 거부: ${rel} (workspaceRoot 밖 경로)`);
      continue;
    }
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, match[2].replace(/^\n/, ""), "utf8");
    report.push(`- 생성 완료: ${rel}`);
  }

  const editRe = /<edit_file\s+path="([^"]+)">([\s\S]*?)<\/edit_file>/g;
  while ((match = editRe.exec(text))) {
    const rel = match[1].trim();
    const target = path.resolve(root, rel);
    if (!isInside(root, target) || !fs.existsSync(target)) {
      report.push(`- 수정 실패: ${rel} (파일 없음 또는 허용 범위 밖)`);
      continue;
    }
    let current = fs.readFileSync(target, "utf8");
    let count = 0;
    const body = match[2];
    const pairRe = /<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>/g;
    let pair;
    while ((pair = pairRe.exec(body))) {
      if (current.includes(pair[1])) {
        current = current.replace(pair[1], pair[2]);
        count++;
      }
    }
    if (count) {
      fs.writeFileSync(target, current, "utf8");
      report.push(`- 수정 완료: ${rel} (${count}건)`);
    } else {
      report.push(`- 수정 실패: ${rel} (일치 텍스트 없음)`);
    }
  }

  const cmdRe = /<run_command>([\s\S]*?)<\/run_command>/g;
  while ((match = cmdRe.exec(text))) {
    const command = match[1].trim();
    const output = await runCommand(command, root, 120000).catch((err) => err.message);
    report.push(`- 명령 실행: ${command}\n\`\`\`\n${String(output).slice(0, 4000)}\n\`\`\``);
  }
  return report;
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("명령 실행 시간이 초과되었습니다."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(`${out}\n(exit ${code})`.trim());
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function handleMessage(msg) {
  switch (msg.type) {
    case "ready":
      post("restoreMessages", chatHistory.map((m) => ({
        role: m.role === "assistant" ? "ai" : "user",
        text: m.content
      })));
      break;
    case "getModels": {
      const detected = await detectModels();
      post("modelsList", detected.models);
      post({
        type: "engineDetected",
        engine: detected.engine === "None" ? "" : detected.engine,
        model: detected.models[0] || ""
      });
      break;
    }
    case "detectEngine": {
      const detected = await detectModels();
      post("response", `${detected.engine} 연결됨\n${detected.models.join("\n") || "모델 없음"}`);
      break;
    }
    case "prompt":
    case "promptWithFile":
      handlePrompt(msg);
      break;
    case "regenerate":
      if (lastPrompt) handlePrompt({ type: "prompt", value: lastPrompt, model: lastModel });
      break;
    case "stopGeneration":
      if (abortController) abortController.abort();
      post("streamEnd");
      break;
    case "newChat":
      chatHistory = [];
      saveJson(HISTORY_PATH, chatHistory);
      post("clearChat");
      break;
    case "requestStatus":
      post("statusUpdate", {
        folderPath: getConfig().localBrainPath,
        fileCount: countMarkdownFiles(getConfig().localBrainPath),
        githubUrl: "",
        lastSync: "",
        syncing: false
      });
      break;
    case "openSettings":
      post("response", `웹 설정 파일: ${CONFIG_PATH}\nworkspaceRoot, ollamaUrl, lmStudioUrl, defaultModel을 여기서 바꿀 수 있습니다.`);
      break;
    case "syncBrain":
    case "injectLocalBrain":
      post("response", `웹 버전 지식 폴더: ${getConfig().localBrainPath}`);
      break;
    case "onboardingState":
      post({
        type: "onboardingState",
        dismissed: true,
        steps: {
          engine: { done: true, detected: "Web", model: "" },
          brain: { done: true, path: getConfig().localBrainPath },
          github: { done: false, url: "" }
        }
      });
      break;
    case "probeIDEModels":
      post({ type: "ideModelsProbed", models: [], error: "웹 버전에서는 IDE 모델 API가 없습니다." });
      break;
    case "corporateInit":
      if (fs.existsSync(getCompanyDir())) postCorporateReady();
      else post(companyState());
      break;
    case "companySetup": {
      const dir = ensureCompanyStructure();
      postCorporateReady();
      post(companyState({
        note: `👔 회사 폴더 준비 완료: ${dir}`
      }));
      break;
    }
    case "companyInterview": {
      const answers = msg.answers || {};
      const companyName = String(answers.name || companyConfig.companyName || "AI 1인 기업").trim();
      const dir = ensureCompanyStructure();
      saveCompanyConfig({
        configured: true,
        companyName,
        oneLiner: String(answers.oneLiner || companyConfig.oneLiner || "").trim(),
        audience: String(answers.audience || companyConfig.audience || "").trim(),
        goalYear: String(answers.goalYear || companyConfig.goalYear || "").trim(),
        goalMonth: String(answers.goalMonth || companyConfig.goalMonth || "").trim(),
        needs: String(answers.needs || companyConfig.needs || "").trim(),
        updatedAt: new Date().toISOString()
      });
      const summary = [
        `# ${companyName}`,
        "",
        `- 한 줄 소개: ${companyConfig.oneLiner || ""}`,
        `- 대상: ${companyConfig.audience || ""}`,
        `- 올해 목표: ${companyConfig.goalYear || ""}`,
        `- 이번 달 목표: ${companyConfig.goalMonth || ""}`,
        `- 필요한 것: ${companyConfig.needs || ""}`
      ].join("\n");
      fs.writeFileSync(path.join(dir, "_shared", "company.md"), summary, "utf8");
      postCorporateReady();
      post(companyState({
        configured: true,
        companyName,
        folderExists: true,
        note: `✅ ${companyName} 설정 완료. 명령을 내려보세요.`
      }));
      break;
    }
    case "loadCompanyConfig":
      post({
        type: "companyConfigLoaded",
        config: {
          name: companyConfig.companyName || "",
          oneLiner: companyConfig.oneLiner || "",
          audience: companyConfig.audience || "",
          goalYear: companyConfig.goalYear || "",
          goalMonth: companyConfig.goalMonth || "",
          needs: companyConfig.needs || ""
        }
      });
      break;
    case "saveCompanyConfig": {
      const cfg = msg.config || {};
      saveCompanyConfig({
        configured: true,
        companyName: String(cfg.name || cfg.companyName || companyConfig.companyName || "AI 1인 기업").trim(),
        oneLiner: String(cfg.oneLiner || companyConfig.oneLiner || "").trim(),
        audience: String(cfg.audience || companyConfig.audience || "").trim(),
        goalYear: String(cfg.goalYear || companyConfig.goalYear || "").trim(),
        goalMonth: String(cfg.goalMonth || companyConfig.goalMonth || "").trim(),
        needs: String(cfg.needs || companyConfig.needs || "").trim(),
        updatedAt: new Date().toISOString()
      });
      post({ type: "companyConfigSaved", ok: true });
      postCorporateReady();
      post(companyState({ configured: true, companyName: companyConfig.companyName }));
      break;
    }
    default:
      post("log", `웹 어댑터: 아직 연결되지 않은 메시지 타입 ${msg.type}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      const html = extractOriginalWebviewHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write("retry: 1000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/message") {
      const msg = await readBody(req);
      send(res, 200, { ok: true });
      handleMessage(msg).catch((err) => post("error", err.message));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const file = path.resolve(ROOT, "." + decodeURIComponent(url.pathname));
      if (!isInside(path.join(ROOT, "assets"), file) || !fs.existsSync(file)) {
        send(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, { "Content-Type": mime(file) });
      fs.createReadStream(file).pipe(res);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  const cfg = getConfig();
  if (!fs.existsSync(CONFIG_PATH)) saveJson(CONFIG_PATH, cfg);
  console.log(`Connect AI web is running at http://127.0.0.1:${PORT}`);
  console.log(`workspaceRoot: ${cfg.workspaceRoot}`);
});
