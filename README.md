# GridWise LLM Energy Optimizer

An enterprise-grade, full-stack decision support and optimization pipeline built for the **BUP CSE Fest 2026 GridWise-LLM Challenge**. It combines OpenRouter LLM interpretation, strict deterministic guardrails, a true 24-hour constrained cost optimizer, and an independent replay verification validator.

---

## Architecture Pipeline

1. **Natural Language Input**: Operator notes are accepted via `POST /optimize-energy`.
2. **LLM Interpretation**: OpenRouter API extracts structured JSON operational directives.
3. **Deterministic Guardrails**: Validates schema compliance, numeric bounds, and rejects malformed outputs without silent conversions.
4. **Constrained Cost Optimizer**: Dynamic programming state-space solver minimizes total daily grid cost ($\sum \text{grid} \times \text{tariff}$) while enforcing hard battery reserves, charge/discharge caps, and exact end-of-day battery neutrality.
5. **Replay Validator**: Independently replays every hour of the optimized schedule to verify energy balance, solar caps, and window constraints.

---

## Endpoints

### `GET /health`
Returns service readiness status.
* **Response**: `{"status": "ok"}`

### `POST /optimize-energy`
Accepts a 24-hour scenario payload and operator notes, returning an optimized energy schedule and total cost in BDT.

---

## Environment Variables

Create a `.env` file in the root directory:
```env
PORT=3000
OPENROUTER_API_KEY=your_openrouter_api_key_here
LLM_MODEL=openrouter/free
