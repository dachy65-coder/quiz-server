const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let results = [];
let savedQuizzes = []; // [{ id, title, questions, createdAt }]
let activeQuizId = null;

function callAnthropic(base64pdf) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64pdf } },
          { type: 'text', text: 'Read this PDF and generate exactly 10 multiple choice quiz questions based on its content. Return ONLY a valid JSON array, no markdown formatting, no explanation, no code fences. Each item must have exactly these fields: q (question string), opts (array of exactly 4 answer strings), ans (integer index 0-3 of the correct answer), exp (one sentence explanation of the correct answer). Example: [{"q":"...","opts":["A","B","C","D"],"ans":0,"exp":"..."}]' }
        ]
      }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'Anthropic API error'));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getActiveQuiz() {
  return savedQuizzes.find(q => q.id === activeQuizId) || null;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- RESULTS ----

  if (req.method === 'POST' && req.url === '/result') {
    try {
      const body = await readBody(req);
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
    return;
  }

  if (req.method === 'GET' && req.url === '/results') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  if (req.method === 'POST' && req.url === '/clear') {
    results = [];
    console.log('Results cleared');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- SAVED QUIZZES ----

  // GET /quizzes — list all saved quizzes (lightweight, no full question text needed for list view but fine to include)
  if (req.method === 'GET' && req.url === '/quizzes') {
    const list = savedQuizzes.map(q => ({
      id: q.id,
      title: q.title,
      count: q.questions.length,
      createdAt: q.createdAt
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ quizzes: list, activeQuizId }));
    return;
  }

  // POST /activate — { quizId } set which saved quiz is active
  if (req.method === 'POST' && req.url === '/activate') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const quiz = savedQuizzes.find(q => q.id === data.quizId);
      if (!quiz) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Quiz not found' }));
        return;
      }
      activeQuizId = quiz.id;
      results = [];
      console.log('Activated quiz:', quiz.title);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, title: quiz.title }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // DELETE /quizzes — { quizId } remove a saved quiz
  if (req.method === 'DELETE' && req.url === '/quizzes') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      savedQuizzes = savedQuizzes.filter(q => q.id !== data.quizId);
      if (activeQuizId === data.quizId) activeQuizId = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // GET /quiz — student fetches the currently active quiz (kept for compatibility with index.html)
  if (req.method === 'GET' && req.url === '/quiz') {
    const active = getActiveQuiz();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(active ? { title: active.title, questions: active.questions } : null));
    return;
  }

  // POST /quiz — manually set/save+activate a quiz (e.g. from a fixed JSON payload)
  if (req.method === 'POST' && req.url === '/quiz') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const quiz = {
        id: Date.now(),
        title: data.title || 'Quiz',
        questions: data.questions,
        createdAt: new Date().toISOString()
      };
      savedQuizzes.push(quiz);
      activeQuizId = quiz.id;
      results = [];
      console.log('Quiz saved & activated:', quiz.title, quiz.questions.length, 'questions');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: quiz.id, title: quiz.title }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // POST /generate-quiz — dashboard sends PDF, server calls AI, saves + activates quiz
  if (req.method === 'POST' && req.url === '/generate-quiz') {
    try {
      if (!ANTHROPIC_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Railway Variables tab.' }));
        return;
      }

      const body = await readBody(req);
      const data = JSON.parse(body);
      const { title, pdfBase64 } = data;

      if (!pdfBase64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing pdfBase64' }));
        return;
      }

      console.log('Generating quiz from PDF:', title);
      const aiResponse = await callAnthropic(pdfBase64);
      const text = (aiResponse.content || []).map(c => c.text || '').join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const questions = JSON.parse(clean);

      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('AI did not return valid questions');
      }

      const quiz = {
        id: Date.now(),
        title: title || 'Generated Quiz',
        questions,
        createdAt: new Date().toISOString()
      };
      savedQuizzes.push(quiz);
      activeQuizId = quiz.id;
      results = [];
      console.log('Quiz generated & activated:', quiz.title, questions.length, 'questions');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: quiz.id, title: quiz.title, count: questions.length }));
    } catch (e) {
      console.error('Generate quiz error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Failed to generate quiz' }));
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    const active = getActiveQuiz();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quiz server running. ' + results.length + ' results stored. ' + savedQuizzes.length + ' saved quizzes. Active: ' + (active ? active.title : 'none') + '. API key configured: ' + (!!ANTHROPIC_API_KEY));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Quiz server running on port', PORT);
  console.log('Anthropic API key configured:', !!ANTHROPIC_API_KEY);
});
