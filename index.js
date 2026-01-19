const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const N3 = require("n3");
const cors = require("cors");


// YARRRML parser (CommonJS deep import per docs)
const Yarrrml = require("@rmlio/yarrrml-parser/lib/rml-generator");

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map(s => s.trim());

// CORS for browser clients
app.use(cors({
  origin: function (origin, cb) {
    // allow non-browser tools (no Origin header) like curl
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

// Ensure preflight is handled for all routes
app.options("*", cors());

const PORT = Number(process.env.PORT || 3000);
const RMLMAPPER_JAR = process.env.RMLMAPPER_JAR || "/opt/rmlmapper.jar";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const MAX_BODY = process.env.MAX_BODY || "4mb";
const DEFAULT_SERIALIZATION = (process.env.DEFAULT_SERIALIZATION || "nquads").trim();

// JSON only for this simplified API
app.use(express.json({ limit: MAX_BODY }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

function isHttpUrl(u) {
    try {
        const url = new URL(u);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

// Optional SSRF allowlist by hostname (recommended if exposed)
function isAllowedHost(u) {
    const allow = (process.env.ALLOWED_FETCH_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
    if (allow.length === 0) return true;
    return allow.includes(new URL(u).hostname);
}

// Safe filename: no dirs, no traversal, only [A-Za-z0-9._-], default data.json
function sanitizeFilename(name, fallback = "data.json") {
    if (!name || typeof name !== "string") return fallback;
    const trimmed = name.trim();
    if (!trimmed) return fallback;
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return fallback;
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return fallback;
    return trimmed;
}

async function fetchJsonToFile(resourceUrl, outPath) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    
    try {
        const resp = await fetch(resourceUrl, { signal: ac.signal });
        if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);
        
        // You said "data.json" always; enforce JSON parse here
        const json = await resp.json();
        await fs.writeFile(outPath, JSON.stringify(json, null, 2), "utf8");
    } finally {
        clearTimeout(t);
    }
}

function runRmlMapper({ workdir, mappingPath, outputPath, serialization, baseIri }) {
    return new Promise((resolve, reject) => {
        const args = ["-jar", RMLMAPPER_JAR, "-m", mappingPath, "-o", outputPath];
        
        if (serialization) args.push("-s", serialization);
        if (baseIri) args.push("-b", baseIri);
        
        const child = spawn("java", args, { cwd: workdir });
        
        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr += d.toString();
            if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
        });
        
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve({ stderr });
            else reject(new Error(`RMLMapper exited with code ${code}\n${stderr}`));
        });
    });
}

function contentTypeFor(serialization) {
    switch (serialization) {
        case "turtle":
        return "text/turtle";
        case "trig":
        return "application/trig";
        case "jsonld":
        return "application/ld+json";
        case "nquads":
        default:
        return "application/n-quads";
    }
}

function quadsToTurtle(quads) {
    return new Promise((resolve, reject) => {
        const writer = new N3.Writer({ format: "Turtle" });
        writer.addQuads(quads);
        writer.end((err, result) => (err ? reject(err) : resolve(result)));
    });
}


app.post("/map", async (req, res) => {
    // Optional output format via query param, default nquads
    const serialization = (req.query.serialization || DEFAULT_SERIALIZATION).toString().trim();
    
    const body = req.body || {};
    const yarrml = body.yarrml;
    
    if (typeof yarrml !== "string" || !yarrml.trim()) {
        return res.status(400).json({
            error: "Missing yarrml",
            hint: 'Body must include: { "yarrml": "...", "resources": [...] }'
        });
    }
    
    const resources = Array.isArray(body.resources) ? body.resources : null;
    if (!resources || resources.length === 0) {
        return res.status(400).json({
            error: "Missing resources",
            hint: 'Provide: "resources": [ { "resourceUrl": "...", "fileName": "data.json" } ]'
        });
    }
    
    // Validate resources list
    const normalized = [];
    for (const r of resources) {
        const resourceUrl = r && typeof r.resourceUrl === "string" ? r.resourceUrl.trim() : "";
        if (!resourceUrl) {
            return res.status(400).json({ error: "Each resource must have resourceUrl" });
        }
        if (!isHttpUrl(resourceUrl)) {
            return res.status(400).json({ error: `resourceUrl must be http(s): ${resourceUrl}` });
        }
        if (!isAllowedHost(resourceUrl)) {
            return res
            .status(403)
            .json({ error: `resourceUrl host not allowed by ALLOWED_FETCH_HOSTS: ${resourceUrl}` });
        }
        
        const fileName = sanitizeFilename(
            r && typeof r.fileName === "string" ? r.fileName : "",
            "data.json"
        );
        
        normalized.push({ resourceUrl, fileName });
    }
    
    // Create per-request working dir
    const jobId = crypto.randomUUID();
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `mapjob-${jobId}-`));
    
    const mappingPath = path.join(workdir, "mapping.ttl");
    const outputExt =
    serialization === "turtle" ? "ttl" : serialization === "jsonld" ? "jsonld" : "nq";
    const outputPath = path.join(workdir, `output.${outputExt}`);
    
    try {
        // 1) Fetch all resources into workdir
        // If duplicates filenames exist, last one wins (you can change this behavior if you want)
        await Promise.all(
            normalized.map(({ resourceUrl, fileName }) =>
                fetchJsonToFile(resourceUrl, path.join(workdir, fileName))
        )
    );
    
    // 2) Convert YARRRML -> RML (Turtle)
    const y2r = new Yarrrml();
    const converted = y2r.convert(yarrml);
    
    console.log("convert() type:", typeof converted, "isArray:", Array.isArray(converted));
    if (Array.isArray(converted)) console.log("first quad keys:", Object.keys(converted[0] || {}));
    
    if (y2r.getLogger && y2r.getLogger().has("error")) {
        return res.status(422).json({
            error: "YARRRML conversion failed",
            logs: y2r.getLogger().getAll()
        });
    }
    
    let rmlTurtle;
    if (typeof converted === "string") {
        rmlTurtle = converted;
    } else if (Array.isArray(converted)) {
        // most likely: RDFJS Quads
        rmlTurtle = await quadsToTurtle(converted);
    } else {
        // last resort: try to stringify (but usually you'll hit the array case)
        throw new Error(`Unexpected yarrrml convert() return type: ${typeof converted}`);
    }
    
    
    // 3) Write mapping
    await fs.writeFile(mappingPath, rmlTurtle, "utf8");
    
    // 4) Run mapper (relative sources like "data.json" resolve within workdir)
    const baseIri = (process.env.BASE_IRI || "").trim();
    await runRmlMapper({
        workdir,
        mappingPath,
        outputPath,
        serialization,
        baseIri: baseIri ? baseIri : undefined
    });
    
    // 5) Return output
    const out = await fs.readFile(outputPath, "utf8");
    res
    .status(200)
    .set("Content-Type", `${contentTypeFor(serialization)}; charset=utf-8`)
    .send(out);
} catch (err) {
    res.status(422).json({
        error: "Mapping failed",
        message: err && err.message ? err.message : String(err)
    });
} finally {
    try {
        await fs.rm(workdir, { recursive: true, force: true });
    } catch {}
}
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`combined map service listening on http://0.0.0.0:${PORT}`);
});
