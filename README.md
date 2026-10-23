# AgentM website

Static site: HTML + CSS + JavaScript. No build step.

## Structure
- index.html      – page content
- monitor.html    – Agent M live demo (job monitoring + self-healing)
- ask.html        – Ask your docs (in-browser document Q&A)
- css/styles.css  – all styles (colours are variables at the top)
- js/main.js      – mobile menu, copy-email button, contact form
- js/monitor.js   – browser port of ../job_monitoring (classifier, healer, sql_guard, run loop) against a simulated BigQuery table
- js/ask.js       – the document agent for ask.html: parse → chunk → embed (bge-small) → IndexedDB vector store → hybrid search → cross-encoder re-rank → exact answer (roberta-squad2) or chat answer (WebLLM)
- assets/         – favicon, images/logos, samples/ (demo documents from ../gen_ai_agent/docs)

## Keeping the demos in sync
- monitor.js mirrors the rules in job_monitoring/classifier.py, healer.py and sql_guard.py. When those change, update the matching section in monitor.js (each section is labelled with its Python file).
- ask.html's "self-hosted" section describes gen_ai_agent (Ollama + Chroma + LlamaIndex). GitHub Pages can't run Python, so the live tools run in the browser.

## Run locally
Open the folder in VS Code, right-click index.html → "Open with Live Server".

## Before launch
- Replace placeholder stats, testimonial and client logos
- Update the email (hello@agentm.ai)
- Connect the contact form (e.g. Formspree, Web3Forms, or your own API)
