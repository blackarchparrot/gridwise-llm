import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. HEALTH ENDPOINT
// ==========================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ==========================================
// 2. STRICT REQUEST VALIDATION
// ==========================================
function validateRequestPayload(body) {
  if (!body || typeof body !== 'object') return "Invalid JSON payload.";
  if (typeof body.scenario_id !== 'string' || !body.scenario_id.trim()) return "Missing or invalid 'scenario_id'.";

  // Operator notes: exactly 1–3 non-empty strings
  if (!Array.isArray(body.operator_notes) || body.operator_notes.length < 1 || body.operator_notes.length > 3) {
    return "'operator_notes' must contain between 1 and 3 items.";
  }
  for (const note of body.operator_notes) {
    if (typeof note !== 'string' || !note.trim()) return "All operator notes must be non-empty strings.";
  }

  // Hours: exactly 24 records
  if (!Array.isArray(body.hours) || body.hours.length !== 24) {
    return "'hours' array must contain exactly 24 hourly entries.";
  }

  for (let i = 0; i < 24; i++) {
    const h = body.hours[i];
    if (!h || typeof h !== 'object') return `Hour ${i}: Invalid entry object.`;
    if (typeof h.demand_kwh !== 'number' || Number.isNaN(h.demand_kwh) || h.demand_kwh < 0) return `Hour ${i}: Invalid demand_kwh.`;
    if (typeof h.solar_kwh !== 'number' || Number.isNaN(h.solar_kwh) || h.solar_kwh < 0) return `Hour ${i}: Invalid solar_kwh.`;
    if (typeof h.tariff_bdt_per_kwh !== 'number' || Number.isNaN(h.tariff_bdt_per_kwh) || h.tariff_bdt_per_kwh < 0) return `Hour ${i}: Invalid tariff_bdt_per_kwh.`;
  }

  // Battery schema check
  const b = body.battery;
  if (!b || typeof b !== 'object') return "Missing 'battery' configuration object.";
  if (typeof b.capacity_kwh !== 'number' || b.capacity_kwh <= 0) return "Invalid battery capacity.";
  if (typeof b.initial_energy_kwh !== 'number' || b.initial_energy_kwh < 0 || b.initial_energy_kwh > b.capacity_kwh) return "Invalid initial battery energy.";
  if (typeof b.minimum_energy_kwh !== 'number' || b.minimum_energy_kwh < 0 || b.minimum_energy_kwh > b.capacity_kwh) return "Invalid minimum battery reserve.";
  if (typeof b.max_charge_kwh_per_hour !== 'number' || b.max_charge_kwh_per_hour < 0) return "Invalid max charge rate.";
  if (typeof b.max_discharge_kwh_per_hour !== 'number' || b.max_discharge_kwh_per_hour < 0) return "Invalid max discharge rate.";

  return null;
}

// ==========================================
// 3. OPENROUTER LLM INTERPRETER
// ==========================================
async function interpretNotes(notes, scenarioId) {
  const prompt = `You are an elite energy systems analyst parsing operator notes for scenario ${scenarioId}.
  Convert each note into a structured JSON directive object.
  Supported directive types ONLY:
  - "solar_reduction": requires structured_adjustment: { "hours": number[], "factor": number (0 to 1) }
  - "minimum_battery_reserve": requires structured_adjustment: { "hours": number[], "minimum_energy_kwh": number }
  - "no_charge_window": requires structured_adjustment: { "hours": number[] }
  - "no_discharge_window": requires structured_adjustment: { "hours": number[] }
  - "max_grid_window": requires structured_adjustment: { "hours": number[], "max_grid_kwh": number }
  - "no_op": use this if the note is irrelevant or non-actionable. structured_adjustment can be null or empty.

  CRITICAL RULES:
  1. Return a JSON array matching the exact length and order of the input notes.
  2. If a note gives a command, 'applies' must be true and 'directive_type' must match one of the 5 active types. Do NOT mark relevant operational notes as applies: false.
  3. Output strictly valid JSON with no markdown wrapping or conversational text.

  Notes to parse:
  ${JSON.stringify(notes)}

  Expected JSON format:
  [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "solar_reduction",
      "structured_adjustment": { "hours": [13, 14], "factor": 0.2 },
      "explanation": "..."
    }
  ]`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "openrouter/free",
      messages: [
        { role: "system", content: "You are a rigid data extraction parser. Return raw JSON arrays only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.0
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API connection failed: ${response.statusText}`);
  }

  const data = await response.json();
  const rawText = data.choices[0].message.content.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) throw new Error("LLM output must be a JSON array.");
  return parsed;
}

// ==========================================
// 4. STRICT GUARDRAIL & VALIDATION LAYER
// ==========================================
function validateAndSanitizeDirectives(llmOutput, notesCount) {
  const allowedTypes = [
    "solar_reduction",
    "minimum_battery_reserve",
    "no_charge_window",
    "no_discharge_window",
    "max_grid_window",
    "no_op"
  ];

  if (!Array.isArray(llmOutput) || llmOutput.length !== notesCount) {
    throw new Error("LLM directive count mismatch with operator notes.");
  }

  return llmOutput.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Malformed directive object at index ${idx}`);
    }
    if (typeof item.applies !== 'boolean') {
      throw new Error(`Directive ${idx}: 'applies' must be boolean.`);
    }
    if (!allowedTypes.includes(item.directive_type)) {
      throw new Error(`Directive ${idx}: Unsupported type '${item.directive_type}'.`);
    }

    const adj = item.structured_adjustment;
    if (item.directive_type !== "no_op") {
      if (!adj || typeof adj !== 'object') {
        throw new Error(`Directive ${idx}: Missing structured_adjustment for active directive.`);
      }
      if (item.directive_type === "solar_reduction") {
        if (!Array.isArray(adj.hours) || typeof adj.factor !== 'number' || adj.factor < 0 || adj.factor > 1) {
          throw new Error(`Directive ${idx}: Invalid solar_reduction parameters.`);
        }
      }
      if (item.directive_type === "minimum_battery_reserve") {
        if (!Array.isArray(adj.hours) || typeof adj.minimum_energy_kwh !== 'number' || adj.minimum_energy_kwh < 0) {
          throw new Error(`Directive ${idx}: Invalid minimum_battery_reserve parameters.`);
        }
      }
      if (item.directive_type === "no_charge_window" || item.directive_type === "no_discharge_window") {
        if (!Array.isArray(adj.hours)) {
          throw new Error(`Directive ${idx}: Invalid window hours array.`);
        }
      }
      if (item.directive_type === "max_grid_window") {
        if (!Array.isArray(adj.hours) || typeof adj.max_grid_kwh !== 'number' || adj.max_grid_kwh < 0) {
          throw new Error(`Directive ${idx}: Invalid max_grid_window parameters.`);
        }
      }
    }

    return {
      note_index: idx,
      applies: item.applies,
      directive_type: item.directive_type,
      structured_adjustment: adj || null,
      explanation: typeof item.explanation === 'string' ? item.explanation : ""
    };
  });
}

// ==========================================
// 5. TRUE 24-HOUR CONSTRAINED COST OPTIMIZER
// ==========================================
function runConstrainedCostOptimizer(hours, battery, directives) {
  const solarFactors = Array(24).fill(1.0);
  const minReserves = Array(24).fill(battery.minimum_energy_kwh);
  const noChargeHours = Array(24).fill(false);
  const noDischargeHours = Array(24).fill(false);
  const maxGrids = Array(24).fill(Infinity);

  directives.forEach(d => {
    if (!d.applies) return;
    const adj = d.structured_adjustment || {};
    const targetHours = Array.isArray(adj.hours) ? adj.hours : [];

    targetHours.forEach(h => {
      if (h >= 0 && h < 24) {
        if (d.directive_type === "solar_reduction") {
          solarFactors[h] = Math.min(solarFactors[h], adj.factor);
        }
        if (d.directive_type === "minimum_battery_reserve") {
          minReserves[h] = Math.max(minReserves[h], adj.minimum_energy_kwh);
        }
        if (d.directive_type === "no_charge_window") {
          noChargeHours[h] = true;
        }
        if (d.directive_type === "no_discharge_window") {
          noDischargeHours[h] = true;
        }
        if (d.directive_type === "max_grid_window") {
          maxGrids[h] = Math.min(maxGrids[h], adj.max_grid_kwh);
        }
      }
    });
  });

  const STEP = 5;
  const minState = 0;
  const maxState = battery.capacity_kwh;

  let currentLayer = new Map();
  const initEnergyRounded = Math.round(battery.initial_energy_kwh / STEP) * STEP;
  currentLayer.set(initEnergyRounded, { cost: 0, schedule: [] });

  for (let h = 0; h < 24; h++) {
    const nextLayer = new Map();
    const hrData = hours[h];
    const availableSolar = hrData.solar_kwh * solarFactors[h];
    const tariff = hrData.tariff_bdt_per_kwh;

    for (const [energyStr, state] of currentLayer.entries()) {
      const currentEnergy = Number(energyStr);

      for (let netPower = -battery.max_discharge_kwh_per_hour; netPower <= battery.max_charge_kwh_per_hour; netPower += STEP) {
        let charge = 0;
        let discharge = 0;

        if (netPower > 0) {
          if (noChargeHours[h]) continue;
          charge = Math.min(netPower, battery.capacity_kwh - currentEnergy);
        } else if (netPower < 0) {
          if (noDischargeHours[h]) continue;
          discharge = Math.min(-netPower, currentEnergy);
        }

        const solarUsed = Math.min(hrData.demand_kwh, availableSolar);
        const unmetDemand = hrData.demand_kwh - solarUsed;
        const grid = Math.max(0, unmetDemand + charge - discharge);

        if (grid > maxGrids[h]) continue;

        const nextEnergy = currentEnergy + charge - discharge;
        if (nextEnergy < minReserves[h] || nextEnergy < minState || nextEnergy > maxState) continue;

        const hourlyCost = grid * tariff;
        const totalCostSoFar = state.cost + hourlyCost;
        const roundedNextEnergy = Math.round(nextEnergy / STEP) * STEP;

        const record = {
          hour: h,
          grid_kwh: Number(grid.toFixed(2)),
          solar_used_kwh: Number(solarUsed.toFixed(2)),
          battery_charge_kwh: Number(charge.toFixed(2)),
          battery_discharge_kwh: Number(discharge.toFixed(2)),
          battery_energy_end_kwh: Number(nextEnergy.toFixed(2))
        };

        if (!nextLayer.has(roundedNextEnergy) || nextLayer.get(roundedNextEnergy).cost > totalCostSoFar) {
          nextLayer.set(roundedNextEnergy, {
            cost: totalCostSoFar,
            schedule: [...state.schedule, record]
          });
        }
      }
    }
    if (nextLayer.size === 0) {
      throw new Error(`Infeasible scenario at hour ${h}: No valid energy state satisfies all directives and battery constraints.`);
    }
    currentLayer = nextLayer;
  }

  let bestFinalState = null;
  let minCost = Infinity;

  for (const [energyVal, state] of currentLayer.entries()) {
    const neutralityDiff = Math.abs(energyVal - battery.initial_energy_kwh);
    if (neutralityDiff <= STEP && state.cost < minCost) {
      minCost = state.cost;
      bestFinalState = state;
    }
  }

  if (!bestFinalState) {
    for (const [energyVal, state] of currentLayer.entries()) {
      if (state.cost < minCost) {
        minCost = state.cost;
        bestFinalState = state;
      }
    }
  }

  return {
    totalCost: bestFinalState.cost,
    schedule: bestFinalState.schedule
  };
}

// ==========================================
// 6. INDEPENDENT REPLAY VALIDATOR
// ==========================================
function verifyScheduleReplay(schedule, hours, battery, directives) {
  const solarFactors = Array(24).fill(1.0);
  const minReserves = Array(24).fill(battery.minimum_energy_kwh);
  const noChargeHours = Array(24).fill(false);
  const noDischargeHours = Array(24).fill(false);
  const maxGrids = Array(24).fill(Infinity);

  directives.forEach(d => {
    if (!d.applies) return;
    const adj = d.structured_adjustment || {};
    const targetHours = Array.isArray(adj.hours) ? adj.hours : [];
    targetHours.forEach(h => {
      if (h >= 0 && h < 24) {
        if (d.directive_type === "solar_reduction") solarFactors[h] = Math.min(solarFactors[h], adj.factor);
        if (d.directive_type === "minimum_battery_reserve") minReserves[h] = Math.max(minReserves[h], adj.minimum_energy_kwh);
        if (d.directive_type === "no_charge_window") noChargeHours[h] = true;
        if (d.directive_type === "no_discharge_window") noDischargeHours[h] = true;
        if (d.directive_type === "max_grid_window") maxGrids[h] = Math.min(maxGrids[h], adj.max_grid_kwh);
      }
    });
  });

  for (let h = 0; h < 24; h++) {
    const row = schedule[h];
    const hrData = hours[h];

    if (noChargeHours[h] && row.battery_charge_kwh > 0.001) {
      throw new Error(`Replay validation failed: Battery charge attempted during no_charge_window at hour ${h}.`);
    }
    if (noDischargeHours[h] && row.battery_discharge_kwh > 0.001) {
      throw new Error(`Replay validation failed: Battery discharge attempted during no_discharge_window at hour ${h}.`);
    }

    const maxSolarAllowed = hrData.solar_kwh * solarFactors[h];
    if (row.solar_used_kwh > maxSolarAllowed + 0.01) {
      throw new Error(`Replay validation failed: Solar usage exceeds reduced limit at hour ${h}.`);
    }

    const lhs = row.grid_kwh + row.solar_used_kwh + row.battery_discharge_kwh;
    const rhs = hrData.demand_kwh + row.battery_charge_kwh;
    if (Math.abs(lhs - rhs) > 0.05) {
      throw new Error(`Replay validation failed: Energy balance mismatch at hour ${h} (LHS: ${lhs}, RHS: ${rhs}).`);
    }

    if (row.battery_energy_end_kwh < minReserves[h] - 0.01) {
      throw new Error(`Replay validation failed: Battery dropped below minimum reserve at hour ${h}.`);
    }
    if (row.battery_energy_end_kwh > battery.capacity_kwh + 0.01) {
      throw new Error(`Replay validation failed: Battery capacity exceeded at hour ${h}.`);
    }
  }
}

// ==========================================
// 7. API ENDPOINT /optimize-energy
// ==========================================
app.post('/optimize-energy', async (req, res) => {
  try {
    const validationError = validateRequestPayload(req.body);
    if (validationError) {
      return res.status(422).json({ error: validationError });
    }

    const { scenario_id, operator_notes, hours, battery } = req.body;

    let rawDirectives;
    try {
      rawDirectives = await interpretNotes(operator_notes, scenario_id);
    } catch (llmErr) {
      return res.status(422).json({ error: `LLM interpretation failed: ${llmErr.message}` });
    }

    let validatedDirectives;
    try {
      validatedDirectives = validateAndSanitizeDirectives(rawDirectives, operator_notes.length);
    } catch (guardErr) {
      return res.status(422).json({ error: `Directive guardrail validation failed: ${guardErr.message}` });
    }

    let optimizedResult;
    try {
      optimizedResult = runConstrainedCostOptimizer(hours, battery, validatedDirectives);
    } catch (optErr) {
      return res.status(422).json({ error: `Optimization infeasible: ${optErr.message}` });
    }

    try {
      verifyScheduleReplay(optimizedResult.schedule, hours, battery, validatedDirectives);
    } catch (replayErr) {
      return res.status(500).json({ error: `Replay validation verification error: ${replayErr.message}` });
    }

    res.json({
      scenario_id,
      status: "success",
      total_cost_bdt: Number(optimizedResult.totalCost.toFixed(2)),
             directives_applied: validatedDirectives,
             schedule: optimizedResult.schedule
    });

  } catch (err) {
    res.status(500).json({ error: `Internal server error: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`GridWise enterprise server running on port ${PORT}`));
}

export default app;
