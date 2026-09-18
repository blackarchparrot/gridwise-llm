import test from 'node:test';
import assert from 'node:assert';
import app from '../server.js';
import http from 'http';

test('Health endpoint check and clean shutdown', async (t) => {
  const server = http.createServer(app);
  
  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
  
  const port = server.address().port;
  
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    const data = await res.json();
    
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'ok');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});
