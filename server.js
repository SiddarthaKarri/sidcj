const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const app = express();
app.use(bodyParser.json({ limit: "50mb" })); // Increased limit for batch inputs
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
// COMPILE ONCE, RUN MULTIPLE TIMES
async function handleBatchExecution(language, jobDir, files, inputs, compileTimeout, runTimeout) {
    // 1. Write Files
    let mainFile = "main";
    if (language === 'python') mainFile = 'main.py';
    if (language === 'javascript' || language === 'node') mainFile = 'main.js';
    if (language === 'java') mainFile = 'Main.java';
    if (language === 'cpp') mainFile = 'main.cpp';
    for (const f of files) {
        // Use provided name or default based on language
        let name = f.name;
        if (!name) {
            if (language === 'cpp') name = 'main.cpp';
            else if (language === 'python') name = 'main.py';
            else if (language === 'java') name = 'Main.java';
            else if (language === 'javascript') name = 'main.js';
        }
        fs.writeFileSync(path.join(jobDir, name), f.content || "", "utf8");
    }
    // 2. Compile (if needed)
    let compileRes = { code: 0, stdout: '', stderr: '' };
    let runCmd = "";
    if (language === 'cpp') {
        compileRes = await runCommand("g++ -std=c++17 -O2 -pipe -static -s *.cpp -o main", jobDir, compileTimeout);
        runCmd = "./main";
    } else if (language === 'java') {
        compileRes = await runCommand("javac *.java", jobDir, compileTimeout);
        runCmd = "java Main";
    } else if (language === 'python') {
        runCmd = "python3 main.py";
    } else if (language === 'javascript' || language === 'node') {
        runCmd = "node main.js";
    }
    if (compileRes.code !== 0) {
        return { compile: compileRes, results: [] }; // Fail early
    }
    // 3. Batch Run
    const results = [];
    for (const input of inputs) {
        const runRes = await runCommand(runCmd, jobDir, runTimeout, input);
        results.push(runRes);
    }
    return { compile: compileRes, results };
}
// -------------------- Routes --------------------
// health
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        server: "railway-judge-optimized",
        batch_support: true,
        languages: ["cpp", "python", "java", "javascript"]
    });
});
// Piston-compatible endpoint with BATCH extension
app.post("/api/v2/piston/execute", async (req, res) => {
    const body = req.body || {};
    let { language, files, stdin, inputs, compile_timeout, run_timeout } = body;
    language = (language || "").toLowerCase();
    files = files || [];
    // Normalize inputs: If 'inputs' array exists, use it. Otherwise use single 'stdin'.
    const batchInputs = (Array.isArray(inputs) && inputs.length > 0) ? inputs : [stdin || ""];
    // Defaults in ms
    compile_timeout = Number(compile_timeout) || 10000;
    run_timeout = Number(run_timeout) || 3000;
    const jobId = uuidv4();
    const jobDir = path.join(EXEC_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    log("[JOB START]", jobId, "lang=", language, "batch_size=", batchInputs.length);
    try {
        if (!["cpp", "c++", "python", "java", "javascript", "node", "js"].includes(language)) {
            return res.status(400).json({ error: `Unsupported language: ${language}` });
        }
        // Normalized language names for internal handler
        if (language === "c++") language = "cpp";
        if (language === "node" || language === "js") language = "javascript";
        const result = await handleBatchExecution(language, jobDir, files, batchInputs, compile_timeout, run_timeout);
        log("[JOB DONE]", jobId);
        // Format response to look mostly like Piston, but with 'results' array
        // For single input (legacy Piston), we map the first result to the top-level run object
        const legacyRun = result.results.length > 0 ? result.results[0] : { code: 0, stdout: "", stderr: "" };
        return res.json({
            language,
            compile: result.compile,
            run: legacyRun, // For backward compatibility
            results: result.results // The BATCH results
        });
    } catch (err) {
        log("[JOB ERROR]", jobId, err.message || err);
        return res.status(500).json({ error: err.message || String(err) });
    } finally {
        // Clean up files
        try {
            fs.rmSync(jobDir, { recursive: true, force: true });
        } catch (_) { }
    }
});
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    log(`Judge server listening on port ${PORT}`);
});
