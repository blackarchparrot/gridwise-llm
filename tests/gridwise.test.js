import test from 'node:test';
import assert from 'node:assert';
import http from 'http';

// Set test environment so server doesn't auto-listen globally
process.env.NODE_ENV = 'test';
import app from '../server.js';

async function withTestServer(testFn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await testFn(`http://localhost:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('Health endpoint returns ok status', async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'ok');
  });
});

test('Rejects request with invalid operator notes count', async () => {
  await withTestServer(async (baseUrl) => {
    const payload = {
      scenario_id: "TEST-01",
      operator_notes: [], // Invalid: must be 1-3
      hours: Array(24).fill({ demand_kwh: 50, solar_kwh: 10, tariff_bdt_per_kwh: 5 }),
      battery: { capacity_kwh: 100, initial_energy_kwh: 50, minimum_energy_kwh: 10, max_charge_kwh_per_hour: 20, max_discharge_kwh_per_hour: 20 }
    };
    const res = await fetch(`${baseUrl}/optimize-energy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(res.status, 422);
    const data = await res.json();
    assert.ok(data.error.includes("operator_notes"));
  });
});
