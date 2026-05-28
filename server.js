const http = require('http');

const PORT = process.env.PORT || 3000;

let results = [];

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  // POST /clear — clear all results
  if (req.method === 'POST' && req.url === '/clear') {
    results = [];
    console.log('Results cleared');
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
