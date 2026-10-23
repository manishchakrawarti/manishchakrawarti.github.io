// Ask your documents: parsing, search and the language model all run in the visitor's browser.
// Nothing is uploaded. Libraries load on demand, only for the file types actually used.

const CDN = {
  pdf: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
  mammoth: "https://cdn.jsdelivr.net/npm/mammoth@1.10.0/mammoth.browser.min.js",
  jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs",
  transformers: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1",
  webllm: "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm",
};

const MAX_FILE_MB = 50;
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const CONTEXT_CHARS = 4500;   // excerpts sent to the model per question
const MAX_EMBED_CHUNKS = 1500;
const MAX_SHEET_ROWS = 20000;

const SYSTEM_PROMPT =
  "You are a document assistant. Answer the user's question using only the numbered excerpts " +
  "from their documents. Cite the excerpts you used like [1] or [2]. If the excerpts do not " +
  "contain the answer, say that you could not find it in the documents. Be clear and concise.";

const state = {
  files: [],          // { id, name, size, status: reading|indexing|ready|error, note }
  chunks: [],         // { fileId, file, loc, text, terms: Map, len, vec }
  semantic: true,     // false if the embedding model fails to load
  engine: null,
  modelId: null,
  busy: false,
  history: [],        // last turns, questions and answers only
};

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), input: $("fileInput"), fileList: $("fileList"), searchMode: $("searchMode"),
  modelSelect: $("modelSelect"), loadModel: $("loadModel"), progress: $("progress"),
  progressBar: $("progressBar"), progressText: $("progressText"), modelStatus: $("modelStatus"),
  msgs: $("msgs"), form: $("askForm"), question: $("question"), send: $("sendBtn"), clear: $("clearChat"),
  sample: $("sampleBtn"),
};

const SAMPLE = { url: "assets/samples/acme_robotics_overview.pdf", name: "acme_robotics_overview.pdf" };

/* ---------- Loading libraries ---------- */

const scriptCache = {};
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return (scriptCache[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(globalName + " did not load")));
    s.onerror = () => { delete scriptCache[src]; reject(new Error("Could not load a required library. Check your connection.")); };
    document.head.appendChild(s);
  }));
}

/* ---------- File parsers: each returns [{ loc, text }] ---------- */

async function parsePdf(buf) {
  const pdfjs = await import(CDN.pdf);
  pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const units = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    units.push({ loc: `page ${i}`, text: content.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("") });
  }
  await doc.destroy();
  return units;
}

async function parseDocx(buf) {
  const mammoth = await loadScript(CDN.mammoth, "mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return [{ loc: "", text: value }];
}

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};
const parseXml = (xml) => new DOMParser().parseFromString(xml, "application/xml");

function drawingText(doc) {
  return [...doc.getElementsByTagNameNS(NS.a, "p")]
    .map((p) => [...p.getElementsByTagNameNS(NS.a, "t")].map((t) => t.textContent).join(""))
    .filter((line) => line.trim() && !/^\d+$/.test(line.trim()))
    .join("\n");
}

// Resolve a relationship target (relative to baseDir, or absolute from the package root).
function resolvePath(baseDir, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function readRels(zip, path) {
  const f = zip.file(path);
  if (!f) return [];
  return [...parseXml(await f.async("string")).getElementsByTagName("Relationship")].map((r) => ({
    id: r.getAttribute("Id"), type: r.getAttribute("Type") || "", target: r.getAttribute("Target") || "",
  }));
}

async function parsePptx(buf) {
  const JSZip = await loadScript(CDN.jszip, "JSZip");
  const zip = await JSZip.loadAsync(buf);

  // Slide order comes from presentation.xml, not from the file names.
  let slidePaths = [];
  const pres = zip.file("ppt/presentation.xml");
  if (pres) {
    const rels = await readRels(zip, "ppt/_rels/presentation.xml.rels");
    const byId = Object.fromEntries(rels.map((r) => [r.id, resolvePath("ppt", r.target)]));
    slidePaths = [...parseXml(await pres.async("string")).getElementsByTagNameNS(NS.p, "sldId")]
      .map((el) => byId[el.getAttributeNS(NS.r, "id")])
      .filter((p) => p && zip.file(p));
  }
  if (!slidePaths.length) {
    slidePaths = Object.keys(zip.files)
      .map((name) => name.match(/^ppt\/slides\/slide(\d+)\.xml$/))
      .filter(Boolean)
      .sort((a, b) => a[1] - b[1])
      .map((m) => m[0]);
  }
  if (!slidePaths.length) throw new Error("This doesn't look like a PowerPoint (.pptx) file.");

  const units = [];
  for (const [i, path] of slidePaths.entries()) {
    let text = drawingText(parseXml(await zip.file(path).async("string")));
    const name = path.split("/").pop();
    const notesRel = (await readRels(zip, `ppt/slides/_rels/${name}.rels`)).find((r) => r.type.endsWith("/notesSlide"));
    const notesFile = notesRel && zip.file(resolvePath("ppt/slides", notesRel.target));
    if (notesFile) {
      const notes = drawingText(parseXml(await notesFile.async("string")));
      if (notes) text += `\nSpeaker notes: ${notes}`;
    }
    units.push({ loc: `slide ${i + 1}`, text });
  }
  return units;
}

async function parseSheet(file, ext) {
  const XLSX = await import(CDN.xlsx);
  const wb = ext === "csv"
    ? XLSX.read(await file.text(), { type: "string" })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });
  const units = [];
  let truncated = false;

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const firstRow = XLSX.utils.decode_range(ws["!ref"]).s.r + 1;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false, defval: "" });
    const filled = (row) => row.some((v) => String(v).trim());
    const headerIdx = rows.findIndex(filled);
    if (headerIdx < 0) continue;
    const header = rows[headerIdx].map((h, i) => String(h).trim() || `Column ${i + 1}`);

    // Group rows into passages, each starting with the sheet name and column names.
    let lines = [], start = null, last = null, size = 0, count = 0;
    const flush = () => {
      if (!lines.length) return;
      const span = start === last ? `row ${start}` : `rows ${start}–${last}`;
      units.push({ loc: `${name}, ${span}`, text: `Sheet "${name}" (columns: ${header.join(", ")})\n${lines.join("\n")}` });
      lines = []; start = null; size = 0;
    };
    for (let i = headerIdx + 1; i < rows.length; i++) {
      if (!filled(rows[i])) continue;
      if (++count > MAX_SHEET_ROWS) { truncated = true; break; }
      const rowNum = firstRow + i;
      const line = `Row ${rowNum}: ` + rows[i]
        .map((v, c) => (String(v).trim() ? `${header[c] || `Column ${c + 1}`}: ${String(v).trim()}` : null))
        .filter(Boolean).join("; ");
      if (size + line.length > CHUNK_CHARS && lines.length) flush();
      if (start === null) start = rowNum;
      last = rowNum;
      lines.push(line);
      size += line.length + 1;
    }
    flush();
    if (headerIdx === rows.length - 1) units.push({ loc: name, text: `Sheet "${name}": ${header.join(", ")}` });
  }
  return { units, note: truncated ? `only the first ${MAX_SHEET_ROWS.toLocaleString()} rows per sheet were read` : "" };
}

async function parseFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`Larger than ${MAX_FILE_MB} MB.`);
  switch (ext) {
    case "pdf": return { units: await parsePdf(await file.arrayBuffer()) };
    case "docx": return { units: await parseDocx(await file.arrayBuffer()) };
    case "pptx": return { units: await parsePptx(await file.arrayBuffer()) };
    case "xlsx": case "xlsm": case "xls": case "ods": case "csv": return parseSheet(file, ext);
    case "txt": case "md": return { units: [{ loc: "", text: await file.text() }] };
    case "doc": case "ppt":
      throw new Error(`Old .${ext} format. Open it in Office and save as .${ext}x, then add it again.`);
    default:
      throw new Error("Unsupported file type.");
  }
}

/* ---------- Chunking ---------- */

function splitText(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      for (const sep of ["\n\n", "\n", ". ", " "]) {
        const cut = text.lastIndexOf(sep, end);
        if (cut > start + CHUNK_CHARS / 2) { end = cut + sep.length; break; }
      }
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    let next = Math.max(end - CHUNK_OVERLAP, start + 1);
    const space = text.indexOf(" ", next);
    if (space > -1 && space < end) next = space + 1;
    start = next;
  }
  return out.filter(Boolean);
}

function toChunks(units, fileId, fileName) {
  const chunks = [];
  for (const u of units) {
    const text = u.text.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    for (const piece of splitText(text)) chunks.push({ fileId, file: fileName, loc: u.loc, text: piece });
  }
  // Word and text files have no pages or slides, so number their passages instead.
  chunks.forEach((c, i) => { if (!c.loc) c.loc = `passage ${i + 1}`; });
  return chunks;
}

/* ---------- Keyword search (BM25) ---------- */

const STOP = new Set("a an and are as at be by do does for from has have how i in is it its of on or that the this to was were what when where which who why will with you your".split(" "));
const tokenize = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => !STOP.has(t));

function indexTerms(chunk) {
  const tokens = tokenize(`${chunk.file} ${chunk.loc} ${chunk.text}`);
  chunk.terms = new Map();
  for (const t of tokens) chunk.terms.set(t, (chunk.terms.get(t) || 0) + 1);
  chunk.len = tokens.length;
}

function keywordRank(question, limit = 30) {
  const q = [...new Set(tokenize(question))];
  const N = state.chunks.length;
  if (!q.length || !N) return [];
  const avg = state.chunks.reduce((s, c) => s + c.len, 0) / N || 1;
  const idf = new Map(q.map((t) => {
    const df = state.chunks.reduce((n, c) => n + (c.terms.has(t) ? 1 : 0), 0);
    return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
  }));
  return state.chunks
    .map((c, i) => {
      let score = 0;
      for (const t of q) {
        const tf = c.terms.get(t);
        if (tf) score += idf.get(t) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.len / avg));
      }
      return [i, score];
    })
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i]) => i);
}

/* ---------- Meaning-based search (small embedding model, ~25 MB, also in the browser) ---------- */

let embedderPromise = null;
function getEmbedder() {
  return (embedderPromise ||= import(CDN.transformers).then(({ pipeline }) =>
    pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" })));
}

async function embed(texts) {
  const out = await (await getEmbedder())(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function embedChunks(chunks, onProgress) {
  if (!state.semantic) return;
  const already = state.chunks.filter((c) => c.vec).length;
  const todo = chunks.slice(0, Math.max(0, MAX_EMBED_CHUNKS - already));
  try {
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const vecs = await embed(batch.map((c) => `${c.loc}: ${c.text}`));
      batch.forEach((c, j) => { c.vec = vecs[j]; });
      onProgress(Math.min(i + 16, todo.length), todo.length);
    }
  } catch (err) {
    console.warn("Meaning-based search unavailable, using keyword search only.", err);
    state.semantic = false;
  }
  renderSearchMode();
}

async function meaningRank(question, limit = 30) {
  if (!state.semantic || !state.chunks.some((c) => c.vec)) return [];
  try {
    const [q] = await embed([question]);
    return state.chunks
      .map((c, i) => [i, c.vec ? dot(q, c.vec) : -Infinity])
      .filter(([, s]) => s > -Infinity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([i]) => i);
  } catch {
    return [];
  }
}

/* ---------- Retrieval ---------- */

async function retrieve(question) {
  const all = state.chunks;
  const totalChars = all.reduce((n, c) => n + c.text.length, 0);
  // Small documents fit whole, which works better for "summarise this" questions.
  if (totalChars <= CONTEXT_CHARS) return all.slice();

  // "slide 3" / "page 12" should always bring back that slide or page.
  const pinned = [];
  for (const m of question.toLowerCase().matchAll(/\b(slide|page)\s*#?\s*(\d+)\b/g)) {
    all.forEach((c, i) => { if (c.loc === `${m[1]} ${m[2]}`) pinned.push(i); });
  }

  // Merge keyword and meaning rankings (reciprocal rank fusion).
  const [kw, sem] = await Promise.all([keywordRank(question), meaningRank(question)]);
  const score = new Map();
  pinned.forEach((i) => score.set(i, 1));
  for (const list of [kw, sem]) list.forEach((i, rank) => score.set(i, (score.get(i) || 0) + 1 / (60 + rank)));

  const picked = [];
  let used = 0;
  for (const [i] of [...score.entries()].sort((a, b) => b[1] - a[1])) {
    if (used + all[i].text.length > CONTEXT_CHARS && picked.length) break;
    picked.push(all[i]);
    used += all[i].text.length;
  }
  return picked;
}

/* ---------- Language model (WebLLM on WebGPU) ---------- */

async function gpuSupport() {
  if (!navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { f16: adapter.features.has("shader-f16") } : null;
  } catch {
    return null;
  }
}

function setProgress(fraction, text) {
  els.progress.hidden = false;
  els.progressBar.style.width = `${Math.round((fraction || 0) * 100)}%`;
  els.progressText.textContent = text || "";
}

function setModelStatus(text, kind = "") {
  els.modelStatus.textContent = text;
  els.modelStatus.className = "model-status" + (kind ? " " + kind : "");
}

async function loadModel() {
  const gpu = await gpuSupport();
  if (!gpu) {
    setModelStatus("Your browser can't run the AI model here. It needs WebGPU: use a recent Chrome or Edge on a computer. You can still search your documents.", "warn");
    return;
  }
  const modelId = `${els.modelSelect.value}-${gpu.f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
  if (state.engine && state.modelId === modelId) return;

  els.loadModel.disabled = els.modelSelect.disabled = true;
  setModelStatus("");
  setProgress(0, "Loading the AI library…");
  try {
    const webllm = await import(CDN.webllm);
    if (!webllm.prebuiltAppConfig.model_list.some((m) => m.model_id === modelId)) throw new Error("This model isn't available.");
    if (state.engine) { await state.engine.unload(); state.engine = null; }
    state.engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (r) => setProgress(r.progress, r.text),
    });
    state.modelId = modelId;
    els.progress.hidden = true;
    setModelStatus(`Ready: ${els.modelSelect.selectedOptions[0].dataset.name} is running on your device.`, "ok");
    els.loadModel.textContent = "Switch model";
  } catch (err) {
    console.error(err);
    state.engine = null;
    state.modelId = null;
    els.progress.hidden = true;
    setModelStatus(`Couldn't load the model: ${err.message || err}. Try the smaller model, or close other tabs to free memory.`, "warn");
  } finally {
    els.loadModel.disabled = els.modelSelect.disabled = false;
  }
}

/* ---------- Rendering ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function renderFiles() {
  els.fileList.replaceChildren(...state.files.map((f) => {
    const li = el("li", `file ${f.status}`);
    li.append(el("span", "file-name", f.name), el("span", "file-meta", `${fmtSize(f.size)} · ${f.note}`));
    const rm = el("button", "file-remove", "×");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${f.name}`);
    rm.addEventListener("click", () => removeFile(f.id));
    li.append(rm);
    return li;
  }));
}

function renderSearchMode() {
  const ready = state.chunks.length;
  els.searchMode.textContent = !ready ? "" : state.semantic
    ? `${ready} passages ready. Searching by keyword and by meaning.`
    : `${ready} passages ready. Searching by keyword (meaning-based search couldn't load).`;
}

function scrollChat() { els.msgs.scrollTop = els.msgs.scrollHeight; }

function addMessage(kind, text) {
  const msg = el("div", `msg ${kind}`);
  msg.append(el("div", "msg-text", text));
  els.msgs.append(msg);
  scrollChat();
  return msg;
}

function addSources(msg, chunks, open) {
  const details = el("details", "sources");
  details.open = open;
  details.append(el("summary", "", `Sources (${chunks.length})`));
  const ol = el("ol");
  for (const c of chunks) {
    const li = el("li");
    li.append(el("b", "", `${c.file} · ${c.loc}`), document.createElement("br"));
    li.append(document.createTextNode(c.text.length > 400 ? c.text.slice(0, 400) + "…" : c.text));
    ol.append(li);
  }
  details.append(ol);
  msg.append(details);
}

function welcome() {
  addMessage("note", "Add a document, then ask a question. For example: “Summarise this document”, “What does slide 3 say?” or “Which region had the highest sales?”");
}

/* ---------- Files ---------- */

let nextId = 1;
async function addFiles(fileList) {
  for (const file of fileList) {
    const entry = { id: nextId++, name: file.name, size: file.size, status: "reading", note: "reading…" };
    state.files.push(entry);
    renderFiles();
    try {
      const { units, note } = await parseFile(file);
      const chunks = toChunks(units, entry.id, file.name);
      if (!chunks.length) throw new Error("No readable text found. Scanned pages and images aren't supported.");
      chunks.forEach(indexTerms);
      if (!state.files.includes(entry)) continue;   // removed while reading
      state.chunks.push(...chunks);
      entry.status = "indexing";
      entry.note = "preparing search…";
      renderFiles();
      renderSearchMode();
      await embedChunks(chunks, (done, total) => { entry.note = `preparing search ${done}/${total}`; renderFiles(); });
      entry.status = "ready";
      entry.note = `${chunks.length} passage${chunks.length === 1 ? "" : "s"}` + (note ? ` · ${note}` : "");
    } catch (err) {
      console.error(err);
      entry.status = "error";
      entry.note = err.message || "Couldn't read this file.";
    }
    renderFiles();
    renderSearchMode();
  }
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  state.chunks = state.chunks.filter((c) => c.fileId !== id);
  renderFiles();
  renderSearchMode();
}

/* ---------- Asking ---------- */

function setBusy(busy) {
  state.busy = busy;
  els.send.textContent = busy ? "Stop" : "Ask";
}

async function ask(question) {
  addMessage("user", question);
  if (!state.chunks.length) {
    addMessage("bot", state.files.some((f) => f.status === "reading" || f.status === "indexing")
      ? "Your document is still being read. Try again in a moment."
      : "Add a document first, using the panel on the left.");
    return;
  }

  setBusy(true);
  const msg = addMessage("bot thinking", "");
  const text = msg.querySelector(".msg-text");
  try {
    const excerpts = await retrieve(question);
    if (!state.engine) {
      msg.classList.remove("thinking");
      text.textContent = excerpts.length
        ? "Here are the passages that best match your question. Load the AI model (step 2) to get a written answer."
        : "I couldn't find anything matching that. Try different words.";
      if (excerpts.length) addSources(msg, excerpts.slice(0, 5), true);
      return;
    }

    const context = excerpts.map((c, i) => `[${i + 1}] (${c.file}, ${c.loc})\n${c.text}`).join("\n\n");
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...state.history.slice(-4),
      { role: "user", content: `Excerpts from my documents:\n\n${context}\n\nQuestion: ${question}` },
    ];
    const stream = await state.engine.chat.completions.create({ messages, stream: true, temperature: 0.2, max_tokens: 600 });
    let answer = "";
    for await (const part of stream) {
      answer += part.choices[0]?.delta?.content || "";
      text.textContent = answer;
      scrollChat();
    }
    msg.classList.remove("thinking");
    if (!answer.trim()) text.textContent = "(No answer was generated.)";
    addSources(msg, excerpts, false);
    state.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    state.history = state.history.slice(-4);
  } catch (err) {
    console.error(err);
    msg.classList.remove("thinking");
    text.textContent = /context|window|length/i.test(String(err))
      ? "That was too long for the model. Try a shorter question, or press Clear chat."
      : `Something went wrong: ${err.message || err}`;
  } finally {
    setBusy(false);
    scrollChat();
  }
}

/* ---------- Wiring ---------- */

els.input.addEventListener("change", () => { addFiles([...els.input.files]); els.input.value = ""; });
["dragenter", "dragover"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((t) => els.drop.addEventListener(t, () => els.drop.classList.remove("drag")));
els.drop.addEventListener("drop", (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

els.sample.addEventListener("click", async () => {
  if (state.files.some((f) => f.name === SAMPLE.name)) return;
  els.sample.disabled = true;
  try {
    const res = await fetch(SAMPLE.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = new File([await res.blob()], SAMPLE.name, { type: "application/pdf" });
    await addFiles([file]);
    addMessage("note", "Sample added: a one-page company overview of Acme Robotics (a fictional company). Try “Who founded Acme Robotics?” or “What can the FetchBot 3000 lift?”");
  } catch (err) {
    console.error(err);
    addMessage("note", "Couldn't load the sample file. Check your connection and try again.");
  } finally {
    els.sample.disabled = false;
  }
});

els.loadModel.addEventListener("click", loadModel);

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) { state.engine?.interruptGenerate(); return; }
  const q = els.question.value.trim();
  if (!q) return;
  els.question.value = "";
  els.question.style.height = "";
  ask(q);
});
els.question.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
});
els.question.addEventListener("input", () => {
  els.question.style.height = "";
  els.question.style.height = Math.min(els.question.scrollHeight, 160) + "px";
});

els.clear.addEventListener("click", () => {
  if (state.busy) return;
  state.history = [];
  els.msgs.replaceChildren();
  state.engine?.resetChat();
  welcome();
});

welcome();
gpuSupport().then((gpu) => {
  if (!gpu) {
    els.loadModel.disabled = els.modelSelect.disabled = true;
    setModelStatus("This browser can't run the AI model (it needs WebGPU: use a recent Chrome or Edge on a computer). You can still search your documents and see matching passages.", "warn");
  }
});
