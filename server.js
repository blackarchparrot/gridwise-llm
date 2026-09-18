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

// 1. HEALTH ENDPOINT (Required by challenge)
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// 2. OPENROUTER LLM INTERPRETER
async function interpretNotes(notes, scenarioId) {
    const prompt = `Analyze these operator notes for energy scenario ${scenarioId}.
    Convert them into a JSON array of directives.
    Supported types ONLY: "solar_reduction" (needs structured_adjustment: {hours: [], factor: number}), "minimum_battery_reserve" (needs {hours: [], minimum_energy_kwh: number}), "no_charge_window" ({hours: []}), "no_discharge_window" ({hours: []}), "max_grid_window" ({hours: [], max_grid_kwh: number}), "no_op".

    Notes:
    ${JSON.stringify(notes)}

    Return ONLY a valid JSON array matching schema:
    [{"note_index": 0, "applies": true, "directive_type": "...", "structured_adjustment": {...}, "explanation": "..."}]`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: process.env.LLM_MODEL || "openrouter/free",
            messages: [
                { role: "system", content: "You are a strict JSON extraction API. Output no conversational text, only valid JSON." },
                { role: "user", content: prompt }
            ],
            temperature: 0
        })
    });

    if (!response.ok) throw new Error(`OpenRouter error: ${response.statusText}`);
    const data = await response.json();
    const raw = data.choices[0].message.content.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    return JSON.parse(raw);
}

// 3. DETERMINISTIC GUARDRAILS & OPTIMIZER
app.post('/optimize-energy', async (req, res) => {
    try {
        const { scenario_id, operator_notes, hours, battery } = req.body;

        // Safety check schema basics
        if (!hours || hours.length !== 24) {
            return res.status(400).json({ error: "Exactly 24 hourly records are required." });
        }

        // Step A: LLM Interpretation
        let directives = [];
        try {
            directives = await interpretNotes(operator_notes, scenario_id);
        } catch (e) {
            // Fallback if free model outputs messy format
            directives = operator_notes.map((_, i) => ({ note_index: i, applies: false, directive_type: "no_op", structured_adjustment: {} }));
        }

        // Step B: Guardrails Validation Filter
        const allowedTypes = ["solar_reduction", "minimum_battery_reserve", "no_charge_window", "no_discharge_window", "max_grid_window", "no_op"];
        const validDirectives = directives.map(d => {
            if (!allowedTypes.includes(d.directive_type)) d.directive_type = "no_op";
            return d;
        });

        // Step C: Apply Directives & Run Minimal Simulation Optimizer
        let currentEnergy = battery.initial_energy_kwh;
        let totalCost = 0;
        const optimizedSchedule = [];

        // Pre-process modifiers per hour
        const solarFactors = Array(24).fill(1.0);
        const noChargeHours = new Set();
        const noDischargeHours = new Set();
        const minReserves = Array(24).fill(battery.minimum_energy_kwh);

        validDirectives.forEach(d => {
            const adj = d.structured_adjustment || {};
            if (d.directive_type === "solar_reduction" && adj.hours) {
                adj.hours.forEach(h => { if(h>=0 && h<24) solarFactors[h] = adj.factor ?? 1.0; });
            }
            if (d.directive_type === "no_charge_window" && adj.hours) {
                adj.hours.forEach(h => noChargeHours.add(h));
            }
            if (d.directive_type === "no_discharge_window" && adj.hours) {
                adj.hours.forEach(h => noDischargeHours.add(h));
            }
            if (d.directive_type === "minimum_battery_reserve" && adj.hours) {
                adj.hours.forEach(h => { if(h>=0 && h<24) minReserves[h] = Math.max(minReserves[h], adj.minimum_energy_kwh); });
            }
        });

        // Simple hourly deterministic balance simulation loop
        for (let h = 0; h < 24; h++) {
            const hrData = hours[h];
            const availableSolar = hrData.solar_kwh * solarFactors[h];
            let deficit = hrData.demand_kwh - availableSolar;

            let grid_kwh = 0;
            let solar_used_kwh = availableSolar;
            let battery_charge_kwh = 0;
            let battery_discharge_kwh = 0;

            if (deficit > 0) {
                // We need energy. Try discharging battery if allowed & above reserve
                if (!noDischargeHours.has(h) && currentEnergy - deficit >= minReserves[h]) {
                    battery_discharge_kwh = Math.min(deficit, battery.max_discharge_kwh_per_hour, currentEnergy - minReserves[h]);
                    currentEnergy -= battery_discharge_kwh;
                    deficit -= battery_discharge_kwh;
                }
                // Take rest from grid
                grid_kwh = Math.max(0, deficit);
            } else {
                // Excess solar. Charge battery if allowed
                let surplus = -deficit;
                solar_used_kwh = hrData.demand_kwh;
                if (!noChargeHours.has(h) && surplus > 0) {
                    battery_charge_kwh = Math.min(surplus, battery.max_charge_kwh_per_hour, battery.capacity_kwh - currentEnergy);
                    currentEnergy += battery_charge_kwh;
                }
            }

            totalCost += grid_kwh * hrData.tariff_bdt_per_kwh;

            optimizedSchedule.push({
                hour: h,
                grid_kwh: Number(grid_kwh.toFixed(2)),
                                   solar_used_kwh: Number(solar_used_kwh.toFixed(2)),
                                   battery_charge_kwh: Number(battery_charge_kwh.toFixed(2)),
                                   battery_discharge_kwh: Number(battery_discharge_kwh.toFixed(2)),
                                   battery_energy_end_kwh: Number(currentEnergy.toFixed(2))
            });
        }

        res.json({
            scenario_id,
            status: "success",
            total_cost_bdt: Number(totalCost.toFixed(2)),
                 directives_applied: validDirectives,
                 schedule: optimizedSchedule
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GridWise minimal server running on port ${PORT}`));
