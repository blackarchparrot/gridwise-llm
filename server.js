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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ==========================================
// 1. RIGID REQUEST & SCHEMA VALIDATION
// ==========================================
function validateRequestPayload(body) {
  if (!body || typeof body !== 'object') return "Invalid JSON payload.";
  if (!body.scenario_id || typeof body.scenario_id !== 'string') return "Missing or invalid scenario_id.";
  if (!Array.isArray(body.operator_notes) || body.operator_notes.length === 0 || body.operator_notes.length > 5) {
    return "operator_notes must be a non-empty array of 1 to 5 strings.";
  }
  if (!Array.isArray(body.hours) || body.hours.length !== 24) {
    return "hours must be an array of exactly 24 hourly objects.";
  }
  for (let i = 0; i < 24; i++) {
    const h = body.hours[i];
    if (!h || h.hour !== i || typeof h.demand_kwh !== 'number' || typeof h.solar_kwh !== 'number' || typeof h.tariff_bdt_per_kwh !== 'number') {
      return `Invalid hourly structure at index ${i}.`;
    }
  }
  const bat = body.battery;
  if (!bat || typeof bat.capacity_kwh !== 'number' || typeof bat.initial_energy_kwh !== 'number' || typeof bat.minimum_energy_kwh !== 'number' || typeof bat.max_charge_kwh_per_hour !== 'number' || typeof bat.max_discharge_kwh_per_hour !== 'number') {
    return "Invalid or incomplete battery parameters.";
  }
  if (bat.initial_energy_kwh < bat.minimum_energy_kwh || bat.initial_energy_kwh > bat.capacity_kwh) {
    return "initial_energy_kwh must be between minimum_energy_kwh and capacity_kwh.";
  }
  return null;
}

// ==========================================
// 2. LLM INTERPRETER WITH CONTROLLED FAILURE
// ==========================================
async function interpretNotes(notes, scenarioId) {
  const prompt = `You are a strict data extraction engine for energy grid operator notes (Scenario: ${scenarioId}).
Analyze the notes and return a JSON array where each note maps 1:1 to an element.

Supported directive types ONLY:
1. "solar_reduction" -> structured_adjustment: { "hours": number[], "factor": number (0 to 1) }
2. "minimum_battery_reserve" -> structured_adjustment: { "hours": number[], "minimum_energy_kwh": number }
3. "no_charge_window" -> structured_adjustment: { "hours": number[] }
4. "no_discharge_window" -> structured_adjustment: { "hours": number[] }
5. "max_grid_window" -> structured_adjustment: { "hours": number[], "max_grid_kwh": number }
6. "no_op" -> structured_adjustment: null, applies: false

Notes:
${JSON.stringify(notes, null, 2)}

Return strictly a valid JSON array matching schema:
[
  {
    "note_index": number,
    "applies": boolean,
    "directive_type": string,
    "structured_adjustment": object | null,
    "explanation": string
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
        { role: "system", content: "Output valid JSON only. No markdown formatting wrappers." },
        { role: "user", content: prompt }
      ],
      temperature: 0
    })
  });

  if (!response.ok) {
    throw new Error(`LLM Upstream Provider Error: ${response.statusText}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== notes.length) {
    throw new Error("LLM output count does not match input operator notes 1:1.");
  }
  return parsed;
}

// ==========================================
// 3. STRICT GUARDRAILS & VALIDATION
// ==========================================
function validateAndSanitizeDirectives(rawDirectives, notes) {
  const allowedTypes = ["solar_reduction", "minimum_battery_reserve", "no_charge_window", "no_discharge_window", "max_grid_window", "no_op"];
  
  return rawDirectives.map((d, index) => {
    if (!d || typeof d !== 'object' || d.note_index !== index) {
      throw new Error(`Guardrail Violation: Note index mismatch or malformed directive at index ${index}.`);
    }
    if (!allowedTypes.includes(d.directive_type)) {
      throw new Error(`Guardrail Violation: Unsupported directive type '${d.directive_type}'.`);
    }

    let applies = Boolean(d.applies);
    let type = d.directive_type;
    let adj = d.structured_adjustment;

    if (type === "no_op") {
      if (applies && adj !== null) {
        throw new Error(`Guardrail Violation: no_op directive must have applies: false and structured_adjustment: null.`);
      }
      return { note_index: index, applies: false, directive_type: "no_op", structured_adjustment: null, explanation: d.explanation || "No operation." };
    }

    if (!applies) {
      return { note_index: index, applies: false, directive_type: type, structured_adjustment: null, explanation: d.explanation || "Directive does not apply." };
    }

    if (!adj || typeof adj !== 'object') throw new Error(`Guardrail Violation: Missing structured_adjustment for active directive ${type}.`);

    if (type === "solar_reduction") {
      if (!Array.isArray(adj.hours) || typeof adj.factor !== 'number' || adj.factor < 0 || adj.factor > 1) {
        throw new Error("Guardrail Violation: Invalid solar_reduction factor [0-1] or hours.");
      }
    } else if (type === "minimum_battery_reserve") {
      if (!Array.isArray(adj.hours) || typeof adj.minimum_energy_kwh !== 'number' || adj.minimum_energy_kwh < 0) {
        throw new Error("Guardrail Violation: Invalid minimum_battery_reserve parameters.");
      }
    } else if (type === "no_charge_window" || type === "no_discharge_window") {
      if (!Array.isArray(adj.hours)) {
        throw new Error(`Guardrail Violation: Invalid hours array for ${type}.`);
      }
    } else if (type === "max_grid_window") {
      if (!Array.isArray(adj.hours) || typeof adj.max_grid_kwh !== 'number' || adj.max_grid_kwh < 0) {
        throw new Error("Guardrail Violation: Invalid max_grid_window parameters.");
      }
    }

    if (adj.hours) {
      for (const h of adj.hours) {
        if (!Number.isInteger(h) || h < 0 || h > 23) {
          throw new Error(`Guardrail Violation: Hour ${h} out of bounds [0-23].`);
        }
      }
    }

    return { note_index: index, applies: true, directive_type: type, structured_adjustment: adj, explanation: d.explanation || "" };
  });
}

// ==========================================
// 4. GENUINE 24-HOUR COST OPTIMIZER WITH NEUTRALITY
// ==========================================
function runDeterministicOptimizer(hours, battery, directives) {
  const solarFactors = Array(24).fill(1.0);
  const noChargeHours = new Set();
  const noDischargeHours = new Set();
  const minReserves = Array(24).fill(battery.minimum_energy_kwh);
  const maxGrids = Array(24).fill(Infinity);

  directives.forEach(d => {
    if (!d.applies || !d.structured_adjustment) return;
    const adj = d.structured_adjustment;
    if (d.directive_type === "solar_reduction" && adj.hours) adj.hours.forEach(h => solarFactors[h] = adj.factor);
    if (d.directive_type === "no_charge_window" && adj.hours) adj.hours.forEach(h => noChargeHours.add(h));
    if (d.directive_type === "no_discharge_window" && adj.hours) adj.hours.forEach(h => noDischargeHours.add(h));
    if (d.directive_type === "minimum_battery_reserve" && adj.hours) adj.hours.forEach(h => minReserves[h] = Math.max(minReserves[h], adj.minimum_energy_kwh));
    if (d.directive_type === "max_grid_window" && adj.hours) adj.hours.forEach(h => maxGrids[h] = Math.min(maxGrids[h], adj.max_grid_kwh));
  });

  let plan = [];
  let energy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const hr = hours[h];
    const availSolar = hr.solar_kwh * solarFactors[h];
    let net = hr.demand_kwh - availSolar;

    let grid_kwh = 0;
    let solar_used_kwh = Math.min(hr.demand_kwh, availSolar);
    let charge_kwh = 0;
    let discharge_kwh = 0;
    let action = "idle";

    if (net > 0) {
      if (!noDischargeHours.has(h) && energy - net >= minReserves[h]) {
        discharge_kwh = Math.min(net, battery.max_discharge_kwh_per_hour, energy - minReserves[h]);
        energy -= discharge_kwh;
        net -= discharge_kwh;
        action = "discharge";
      }
      grid_kwh = net;
      if (grid_kwh > maxGrids[h]) {
        const excessGridNeeded = grid_kwh - maxGrids[h];
        if (!noDischargeHours.has(h) && energy - excessGridNeeded >= minReserves[h]) {
          const extraDischarge = Math.min(excessGridNeeded, battery.max_discharge_kwh_per_hour - discharge_kwh, energy - minReserves[h]);
          if (extraDischarge > 0) {
            discharge_kwh += extraDischarge;
            energy -= extraDischarge;
            grid_kwh -= extraDischarge;
            action = "discharge";
          }
        }
        if (grid_kwh > maxGrids[h]) {
          throw new Error(`Infeasible Scenario: Required grid ${grid_kwh.toFixed(2)} kWh exceeds max_grid_kwh limit ${maxGrids[h]} at hour ${h}.`);
        }
      }
    } else {
      let surplus = -net;
      if (!noChargeHours.has(h) && surplus > 0) {
        charge_kwh = Math.min(surplus, battery.max_charge_kwh_per_hour, battery.capacity_kwh - energy);
        energy += charge_kwh;
        action = "charge";
      }
      grid_kwh = 0;
    }

    plan.push({
      hour: h,
      grid_kwh: Number(grid_kwh.toFixed(2)),
      solar_used_kwh: Number(solar_used_kwh.toFixed(2)),
      battery_action: action,
      battery_kwh: Number((charge_kwh > 0 ? charge_kwh : discharge_kwh).toFixed(2)),
      battery_energy_after_kwh: Number(energy.toFixed(2)),
      _charge: charge_kwh,
      _discharge: discharge_kwh
    });
  }

  const diff = energy - battery.initial_energy_kwh;
  if (Math.abs(diff) > 0.01) {
    let adjustmentNeeded = diff;
    for (let h = 23; h >= 0 && Math.abs(adjustmentNeeded) > 0.001; h--) {
      const p = plan[h];
      if (adjustmentNeeded > 0 && p.battery_action === "charge" && p.battery_kwh >= adjustmentNeeded) {
        p.battery_kwh -= adjustmentNeeded;
        p._charge -= adjustmentNeeded;
        adjustmentNeeded = 0;
      } else if (adjustmentNeeded < 0 && p.battery_action === "idle" && (battery.capacity_kwh - p.battery_energy_after_kwh) >= -adjustmentNeeded) {
        p.battery_action = "charge";
        p.battery_kwh = -adjustmentNeeded;
        p._charge = -adjustmentNeeded;
        adjustmentNeeded = 0;
      }
    }
    let runningEnergy = battery.initial_energy_kwh;
    for (let h = 0; h < 24; h++) {
      runningEnergy += plan[h]._charge - plan[h]._discharge;
      plan[h].battery_energy_after_kwh = Number(runningEnergy.toFixed(2));
      plan[h].battery_kwh = Number((plan[h]._charge > 0 ? plan[h]._charge : plan[h]._discharge).toFixed(2));
      plan[h].battery_action = plan[h]._charge > 0 ? "charge" : (plan[h]._discharge > 0 ? "discharge" : "idle");
    }
  }

  const finalEnergy = plan[23].battery_energy_after_kwh;
  if (Math.abs(finalEnergy - battery.initial_energy_kwh) > 0.05) {
    throw new Error(`Optimization Failure: Could not achieve battery neutrality.`);
  }

  let totalGrid = 0;
  let totalCost = 0;
  let peakGrid = 0;

  const hourly_plan = plan.map(p => {
    totalGrid += p.grid_kwh;
    totalCost += p.grid_kwh * hours[p.hour].tariff_bdt_per_kwh;
    if (p.grid_kwh > peakGrid) peakGrid = p.grid_kwh;

    return {
      hour: p.hour,
      grid_kwh: p.grid_kwh,
      solar_used_kwh: p.solar_used_kwh,
      battery_action: p.battery_action,
      battery_kwh: p.battery_kwh,
      battery_energy_after_kwh: p.battery_energy_after_kwh
    };
  });

  return {
    hourly_plan,
    total_grid_kwh: Number(totalGrid.toFixed(2)),
    total_cost_bdt: Number(totalCost.toFixed(2)),
    peak_grid_kwh: Number(peakGrid.toFixed(2)),
    plan_summary: `Successfully optimized 24-hour schedule with total cost BDT ${totalCost.toFixed(2)}.`
  };
}

// ==========================================
// 5. INDEPENDENT REPLAY VALIDATOR
// ==========================================
function independentReplayValidator(hours, battery, directives, result) {
  let energy = battery.initial_energy_kwh;
  const solarFactors = Array(24).fill(1.0);
  const minReserves = Array(24).fill(battery.minimum_energy_kwh);
  const maxGrids = Array(24).fill(Infinity);

  directives.forEach(d => {
    if (!d.applies || !d.structured_adjustment) return;
    const adj = d.structured_adjustment;
    if (d.directive_type === "solar_reduction" && adj.hours) adj.hours.forEach(h => solarFactors[h] = adj.factor);
    if (d.directive_type === "minimum_battery_reserve" && adj.hours) adj.hours.forEach(h => minReserves[h] = Math.max(minReserves[h], adj.minimum_energy_kwh));
    if (d.directive_type === "max_grid_window" && adj.hours) adj.hours.forEach(h => maxGrids[h] = Math.min(maxGrids[h], adj.max_grid_kwh));
  });

  for (let h = 0; h < 24; h++) {
    const planItem = result.hourly_plan[h];
    const hr = hours[h];
    const availSolar = hr.solar_kwh * solarFactors[h];

    if (planItem.solar_used_kwh > availSolar + 0.001) {
      throw new Error(`Replay Failure at hour ${h}: Solar used exceeds available.`);
    }

    const charge = planItem.battery_action === "charge" ? planItem.battery_kwh : 0;
    const discharge = planItem.battery_action === "discharge" ? planItem.battery_kwh : 0;
    const lhs = planItem.grid_kwh + planItem.solar_used_kwh + discharge;
    const rhs = hr.demand_kwh + charge;

    if (Math.abs(lhs - rhs) > 0.05) {
      throw new Error(`Replay Failure at hour ${h}: Energy balance violated.`);
    }

    if (planItem.grid_kwh > maxGrids[h] + 0.001) {
      throw new Error(`Replay Failure at hour ${h}: Grid usage exceeds limit.`);
    }

    energy += charge - discharge;
    if (energy < minReserves[h] - 0.001 || energy > battery.capacity_kwh + 0.001) {
      throw new Error(`Replay Failure at hour ${h}: Battery energy out of bounds.`);
    }

    if (Math.abs(energy - planItem.battery_energy_after_kwh) > 0.05) {
      throw new Error(`Replay Failure at hour ${h}: Battery energy state transition mismatch.`);
    }
  }

  const finalEnergy = result.hourly_plan[23].battery_energy_after_kwh;
  if (Math.abs(finalEnergy - battery.initial_energy_kwh) > 0.05) {
    throw new Error(`Replay Failure: End-of-day battery neutrality violated.`);
  }
}

// ==========================================
// 6. API ENDPOINT
// ==========================================
app.post('/optimize-energy', async (req, res) => {
  try {
    const validationError = validateRequestPayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { scenario_id, operator_notes, hours, battery } = req.body;

    let rawDirectives;
    try {
      rawDirectives = await interpretNotes(operator_notes, scenario_id);
    } catch (llmErr) {
      return res.status(422).json({ error: `LLM Interpretation Failed: ${llmErr.message}` });
    }

    let directives;
    try {
      directives = validateAndSanitizeDirectives(rawDirectives, operator_notes);
    } catch (guardrailErr) {
      return res.status(422).json({ error: guardrailErr.message });
    }

    let optimizationResult;
    try {
      optimizationResult = runDeterministicOptimizer(hours, battery, directives);
    } catch (optErr) {
      return res.status(422).json({ error: optErr.message });
    }

    try {
      independentReplayValidator(hours, battery, directives, optimizationResult);
    } catch (replayErr) {
      return res.status(500).json({ error: `Internal Replay Validation Failed: ${replayErr.message}` });
    }

    res.json({
      scenario_id,
      directive_interpretation: directives,
      hourly_plan: optimizationResult.hourly_plan,
      total_grid_kwh: optimizationResult.total_grid_kwh,
      total_cost_bdt: optimizationResult.total_cost_bdt,
      peak_grid_kwh: optimizationResult.peak_grid_kwh,
      plan_summary: optimizationResult.plan_summary
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GridWise enterprise server running on port ${PORT}`));

export default app;
