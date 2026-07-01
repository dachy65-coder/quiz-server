const http = require('http');
const https = require('https');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdfs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      pdf_data TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      pdf_id INTEGER REFERENCES pdfs(id) ON DELETE SET NULL,
      pdf_title TEXT,
      title TEXT NOT NULL,
      questions JSONB NOT NULL,
      question_count INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
      quiz_title TEXT NOT NULL,
      label TEXT NOT NULL,
      is_active BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS results (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      quiz_id INTEGER,
      student_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      pct INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResp(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function callAnthropic(pdfBase64, questionCount, variation) {
  return new Promise((resolve, reject) => {
    const variationNote = variation ? ' Generate a DIFFERENT set of questions than you might have generated before — focus on different topics and aspects.' : '';
    const prompt = `Read this PDF and generate exactly ${questionCount} multiple choice quiz questions based on its content.${variationNote} Return ONLY a valid JSON array, no markdown, no explanation. Each item: q (question string), opts (array of 4 strings), ans (correct index 0-3), exp (one sentence explanation). Example: [{"q":"...","opts":["A","B","C","D"],"ans":0,"exp":"..."}]`;
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt }
      ]}]
    });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    };
    const req = https.request(options, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) { reject(new Error(p.error.message)); return; }
          resolve(p);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const path = urlObj.pathname;
  const method = req.method;

  try {
    if (method === 'GET' && path === '/') {
      const r = await pool.query('SELECT COUNT(*) FROM pdfs');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Quiz Server v2. PDFs: ${r.rows[0].count}. API key: ${!!ANTHROPIC_API_KEY}`);
      return;
    }

    // PDFs
    if (method === 'GET' && path === '/pdfs') {
      const r = await pool.query('SELECT id, title, filename, created_at FROM pdfs ORDER BY created_at DESC');
      jsonResp(res, 200, r.rows); return;
    }
    if (method === 'POST' && path === '/pdfs') {
      const data = JSON.parse(await readBody(req));
      const r = await pool.query('INSERT INTO pdfs (title,filename,pdf_data) VALUES ($1,$2,$3) RETURNING id,title,filename,created_at', [data.title, data.filename, data.pdfBase64]);
      jsonResp(res, 200, { ok: true, pdf: r.rows[0] }); return;
    }
    const pdfDel = path.match(/^\/pdfs\/(\d+)$/);
    if (method === 'DELETE' && pdfDel) {
      await pool.query('DELETE FROM pdfs WHERE id=$1', [pdfDel[1]]);
      jsonResp(res, 200, { ok: true }); return;
    }

    // Quizzes
    if (method === 'GET' && path === '/quizzes') {
      const r = await pool.query(`SELECT q.id,q.title,q.pdf_id,q.pdf_title,q.question_count,q.created_at,COUNT(DISTINCT s.id)::int as session_count FROM quizzes q LEFT JOIN sessions s ON s.quiz_id=q.id GROUP BY q.id ORDER BY q.created_at DESC`);
      const active = await pool.query('SELECT quiz_id FROM sessions WHERE is_active=TRUE LIMIT 1');
      jsonResp(res, 200, { quizzes: r.rows, activeQuizId: active.rows[0]?.quiz_id || null }); return;
    }
    const quizDel = path.match(/^\/quizzes\/(\d+)$/);
    if (method === 'DELETE' && quizDel) {
      await pool.query('DELETE FROM quizzes WHERE id=$1', [quizDel[1]]);
      jsonResp(res, 200, { ok: true }); return;
    }

    // Generate quiz
    if (method === 'POST' && path === '/generate-quiz') {
      if (!ANTHROPIC_API_KEY) { jsonResp(res, 500, { error: 'Missing ANTHROPIC_API_KEY in Railway Variables' }); return; }
      const data = JSON.parse(await readBody(req));
      const { pdfId, pdfBase64, pdfFilename, title, questionCount = 10, variation = false } = data;
      let pdfData, pdfTitle, pdfIdToUse;
      if (pdfId) {
        const r = await pool.query('SELECT pdf_data,title FROM pdfs WHERE id=$1', [pdfId]);
        if (!r.rows[0]) { jsonResp(res, 404, { error: 'PDF not found' }); return; }
        pdfData = r.rows[0].pdf_data; pdfTitle = title || r.rows[0].title; pdfIdToUse = pdfId;
      } else if (pdfBase64) {
        const fname = pdfFilename || 'upload.pdf';
        const t = title || fname.replace('.pdf','').replace(/_/g,' ');
        const r = await pool.query('INSERT INTO pdfs (title,filename,pdf_data) VALUES ($1,$2,$3) RETURNING id', [t, fname, pdfBase64]);
        pdfData = pdfBase64; pdfTitle = t; pdfIdToUse = r.rows[0].id;
      } else { jsonResp(res, 400, { error: 'Provide pdfId or pdfBase64' }); return; }

      console.log(`Generating ${questionCount} questions from: ${pdfTitle}`);
      const aiResp = await callAnthropic(pdfData, questionCount, variation);
      const text = (aiResp.content || []).map(c => c.text || '').join('');
      const questions = JSON.parse(text.replace(/```json|```/g,'').trim());
      if (!Array.isArray(questions) || !questions.length) throw new Error('AI returned no questions');

      const quizTitle = title || `${pdfTitle} (${questions.length}Q${variation?' v2':''})`;
      const qr = await pool.query('INSERT INTO quizzes (pdf_id,pdf_title,title,questions,question_count) VALUES ($1,$2,$3,$4,$5) RETURNING id,title', [pdfIdToUse, pdfTitle, quizTitle, JSON.stringify(questions), questions.length]);
      jsonResp(res, 200, { ok: true, quizId: qr.rows[0].id, title: qr.rows[0].title, count: questions.length, pdfId: pdfIdToUse }); return;
    }

    // Activate quiz
    if (method === 'POST' && path === '/activate') {
      const data = JSON.parse(await readBody(req));
      const quiz = await pool.query('SELECT title FROM quizzes WHERE id=$1', [data.quizId]);
      if (!quiz.rows[0]) { jsonResp(res, 404, { error: 'Quiz not found' }); return; }
      await pool.query('UPDATE sessions SET is_active=FALSE,ended_at=NOW() WHERE is_active=TRUE');
      const label = data.sessionLabel || `${quiz.rows[0].title} — ${new Date().toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})}`;
      const sr = await pool.query('INSERT INTO sessions (quiz_id,quiz_title,label,is_active) VALUES ($1,$2,$3,TRUE) RETURNING id', [data.quizId, quiz.rows[0].title, label]);
      jsonResp(res, 200, { ok: true, sessionId: sr.rows[0].id, title: quiz.rows[0].title, label }); return;
    }

    // Student: get active quiz
    if (method === 'GET' && path === '/quiz') {
      const r = await pool.query(`SELECT q.title,q.questions,s.id as session_id FROM sessions s JOIN quizzes q ON s.quiz_id=q.id WHERE s.is_active=TRUE LIMIT 1`);
      jsonResp(res, 200, r.rows[0] ? { title: r.rows[0].title, questions: r.rows[0].questions, sessionId: r.rows[0].session_id } : null); return;
    }

    // Student: submit result
    if (method === 'POST' && path === '/result') {
      const data = JSON.parse(await readBody(req));
      const s = await pool.query('SELECT id,quiz_id FROM sessions WHERE is_active=TRUE LIMIT 1');
      if (!s.rows[0]) { jsonResp(res, 400, { error: 'No active session' }); return; }
      const pct = Math.round((data.score/(data.total||10))*100);
      await pool.query('INSERT INTO results (session_id,quiz_id,student_name,score,total,pct) VALUES ($1,$2,$3,$4,$5,$6)', [s.rows[0].id, s.rows[0].quiz_id, data.name, data.score, data.total, pct]);
      console.log('Result:', data.name, pct+'%');
      jsonResp(res, 200, { ok: true }); return;
    }

    // Live results
    if (method === 'GET' && path === '/results/live') {
      const s = await pool.query('SELECT id,quiz_title,label FROM sessions WHERE is_active=TRUE LIMIT 1');
      if (!s.rows[0]) { jsonResp(res, 200, { session: null, results: [] }); return; }
      const r = await pool.query('SELECT student_name as name,score,total,pct,created_at as timestamp FROM results WHERE session_id=$1 ORDER BY created_at DESC', [s.rows[0].id]);
      jsonResp(res, 200, { session: s.rows[0], results: r.rows }); return;
    }

    // Sessions list
    if (method === 'GET' && path === '/sessions') {
      const r = await pool.query(`SELECT s.id,s.label,s.quiz_title,s.is_active,s.created_at,s.ended_at,COUNT(r.id)::int as result_count,ROUND(AVG(r.pct))::int as avg_pct FROM sessions s LEFT JOIN results r ON r.session_id=s.id GROUP BY s.id ORDER BY s.created_at DESC`);
      jsonResp(res, 200, r.rows); return;
    }

    // Session results
    const sessRes = path.match(/^\/sessions\/(\d+)\/results$/);
    if (method === 'GET' && sessRes) {
      const s = await pool.query('SELECT label,quiz_title FROM sessions WHERE id=$1', [sessRes[1]]);
      const r = await pool.query('SELECT student_name as name,score,total,pct,created_at as timestamp FROM results WHERE session_id=$1 ORDER BY pct DESC', [sessRes[1]]);
      jsonResp(res, 200, { session: s.rows[0], results: r.rows }); return;
    }

    // Session CSV export
    const sessExp = path.match(/^\/sessions\/(\d+)\/export$/);
    if (method === 'GET' && sessExp) {
      const r = await pool.query('SELECT student_name,score,total,pct,created_at FROM results WHERE session_id=$1 ORDER BY pct DESC', [sessExp[1]]);
      const rows = [['Name','Score','Total','Percent','Date'], ...r.rows.map(row => [row.student_name,row.score,row.total,row.pct+'%',new Date(row.created_at).toLocaleString()])];
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="session-${sessExp[1]}.csv"` });
      res.end(rows.map(r=>r.join(',')).join('\n')); return;
    }

    // End session
    if (method === 'POST' && path === '/clear') {
      await pool.query('UPDATE sessions SET is_active=FALSE,ended_at=NOW() WHERE is_active=TRUE');
      jsonResp(res, 200, { ok: true }); return;
    }

    jsonResp(res, 404, { error: 'Not found' });

  } catch(e) {
    console.error('Error:', e.message);
    jsonResp(res, 500, { error: e.message || 'Server error' });
  }
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log('Quiz server v2 on port', PORT);
    console.log('API key configured:', !!ANTHROPIC_API_KEY);
  });
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
