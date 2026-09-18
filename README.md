# GridWise LLM - BUP CSE Fest 2026

An AI-powered and mathematically validated microgrid energy optimization system built for the **BUP CSE Fest 2026 GridWise-LLM Challenge**.

## Architecture Pipeline
1. **LLM Interpretation**: Parses unstructured natural language operator notes via OpenRouter into structured JSON directives.
2. **Deterministic Guardrails**: Validates all factor boundaries, hour ranges, and schema integrity to eliminate hallucinations.
3. **Mathematical Optimizer**: Solves cost minimization ($\sum \text{grid} \times \text{tariff}$) while enforcing hourly constraints and **end-to-end battery neutrality**.
4. **Replay Validation**: Confirms energy balances and boundary rules.

## API Endpoints
- `GET /health` - Readiness check.
- `POST /optimize-energy` - Full optimization pipeline endpoint.

## Local Setup & Run
```bash
npm install
npm start
