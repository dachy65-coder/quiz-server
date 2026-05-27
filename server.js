const http = require('http');

const PORT = process.env.PORT || 3000;

// In-memory store (persists while server is running)
let results = [];

const server = http.createServer((req, res) => {
  // CORS headers — allow requests from GitLab Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /result — student submits score
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.name || data.score === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing name or score' }));
          return;
        }
        const entry = {
          id: Date.now(),
          name: data.name,
          score: data.score,
          total: data.total || 10,
          pct: Math.round((data.score / (data.total || 10)) * 100),
          timestamp: new Date().toISOString()
        };
        results.push(entry);
        console.log('Result saved:', entry.name, entry.pct + '%');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /results — dashboard fetches all results
  if (req.method === 'GET' && req.url === '/results') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // DELETE /results — clear all (dashboard reset button)
  if (req.method === 'DELETE' && req.url === '/results') {
    results = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quiz server running. ' + results.length + ' results stored.');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Quiz server running on port', PORT);
});
