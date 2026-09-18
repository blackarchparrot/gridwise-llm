# ⚡ GridWise LLM — BUP CSE Fest 2026

An enterprise-grade, deterministic-backed full-stack energy optimization engine that interprets natural language operator notes using an LLM, applies rigid safety guardrails, and solves 24-hour grid schedules using JavaScript.

## 🛠️ Architecture Pipeline
1. **Natural Language Input** (Operator notes)
2. **LLM Interpretation** (OpenRouter AI structured extraction)
3. **Deterministic Guardrails** (Schema, hour mapping, and factor validation)
4. **Mathematical Optimizer** (Dynamic energy balancing & battery constraint resolution)
5. **Replay Validation & Response**

## 🚀 API Endpoints
- `GET /health` — Returns service readiness status (`{"status": "ok"}`).
- `POST /optimize-energy` — Accepts scenario payload, evaluates notes, and returns the optimized 24-hour schedule and total cost in BDT.

## 💻 Local Setup & Testing
```bash
# Install dependencies
npm install

# Run test suite
npm test

# Start server
npm start
