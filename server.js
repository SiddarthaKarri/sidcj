const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// Base directory for all executions
const EXEC_DIR = "/tmp/executions";

// Ensure base dir exists
if (!fs.existsSync(EXEC_DIR)) {
  fs.mkdirSync(EXEC_DIR, { recursive: true });
}

// Small helper for logging
function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

// Promise wrapper for exec
function runCommand(cmd, cwd, timeoutMs, inputStr = "") {
  return new Promise((resolve) => {
    const start = Date.now();

    const child = exec(
      cmd,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024 // 10MB
      },
      (error, stdout, stderr) => {
        const timeMs = Date.now() - start;

        if (error && error.killed && error.signal === "SIGTERM") {
          return resolve({
            stdout: "",
            stderr: "Time limit exceeded",
            code: 124,
            timeMs
          });
        }

        const code = error && typeof error.code === "number" ? error.code : 0;

        resolve({
          stdout,
          stderr,
          code,
          timeMs
        });
      }
    );

    if (inputStr) {
      child.stdin.write(inputStr);
    }
    child.stdin.end();
  });
}

// -------------------- Language Handlers --------------------

async function handleCPP(jobDir, files, stdin, compileTimeout, runTimeout) {
  // Save all files
  for (const f of files) {
    const name = f.name || "main.cpp";
    fs.writeFileSync(path.join(jobDir, name), f.content || "", "utf8");
  }

  // Compile
  const compileRes = await runCommand(
    "g++ -std=c++17 -O2 -pipe -static -s *.cpp -o main",
    jobDir,
    compileTimeout
  );

  if (compileRes.code !== 0) {
    return { compile: compileRes };
  }

  // Run
  const runRes = await runCommand(
    "./main",
    jobDir,
    runTimeout,
    stdin || ""
  );

  return { compile: compileRes, run: runRes };
}

async function handlePython(jobDir, files, stdin, runTimeout) {
  let mainFile = "main.py";

  for (const f of files) {
    const name = f.name || "main.py";
    if (name.endsWith(".py")) mainFile = name;
    fs.writeFileSync(path.join(jobDir, name), f.content || "", "utf8");
  }

  const runRes = await runCommand(
    `python3 ${mainFile}`,
    jobDir,
    runTimeout,
    stdin || ""
  );

  return { run: runRes };
}

async function handleJava(jobDir, files, stdin, compileTimeout, runTimeout) {
  // By default expect Main.java
  for (const f of files) {
    const name = f.name || "Main.java";
    fs.writeFileSync(path.join(jobDir, name), f.content || "", "utf8");
  }

  const compileRes = await runCommand(
    "javac *.java",
    jobDir,
    compileTimeout
  );

  if (compileRes.code !== 0) {
    return { compile: compileRes };
  }

  const runRes = await runCommand(
    "java Main",
    jobDir,
    runTimeout,
    stdin || ""
  );

  return { compile: compileRes, run: runRes };
}

async function handleJS(jobDir, files, stdin, runTimeout) {
  let mainFile = "main.js";

  for (const f of files) {
    const name = f.name || "main.js";
    if (name.endsWith(".js")) mainFile = name;
    fs.writeFileSync(path.join(jobDir, name), f.content || "", "utf8");
  }

  const runRes = await runCommand(
    `node ${mainFile}`,
    jobDir,
    runTimeout,
    stdin || ""
  );

  return { run: runRes };
}

// -------------------- Routes --------------------

// health
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    server: "railway-judge",
    languages: ["cpp", "python", "java", "javascript"]
  });
});

// Piston-compatible endpoint
app.post("/api/v2/piston/execute", async (req, res) => {
  const body = req.body || {};
  let { language, files, stdin, compile_timeout, run_timeout } = body;

  language = (language || "").toLowerCase();
  files = files || [];
  stdin = stdin || "";

  // Defaults in ms
  compile_timeout = Number(compile_timeout) || 5000;
  run_timeout = Number(run_timeout) || 3000;

  const jobId = uuidv4();
  const jobDir = path.join(EXEC_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  log("[JOB START]", jobId, "lang=", language);

  try {
    let result;

    if (language === "cpp" || language === "c++") {
      result = await handleCPP(jobDir, files, stdin, compile_timeout, run_timeout);
    } else if (language === "python") {
      result = await handlePython(jobDir, files, stdin, run_timeout);
    } else if (language === "java") {
      result = await handleJava(jobDir, files, stdin, compile_timeout, run_timeout);
    } else if (language === "javascript" || language === "node" || language === "js") {
      result = await handleJS(jobDir, files, stdin, run_timeout);
    } else {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    log("[JOB DONE]", jobId);

    return res.json({
      language,
      ...result
    });
  } catch (err) {
    log("[JOB ERROR]", jobId, err.message || err);
    return res.status(500).json({ error: err.message || String(err) });
  } finally {
    // Clean up files
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  log(`Judge server listening on port ${PORT}`);
});
