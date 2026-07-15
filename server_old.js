require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

// Verifica se o .env foi carregado corretamente antes de tentar conectar
const requiredVars = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
const missing = requiredVars.filter(v => !process.env[v]);
if (missing.length) {
  console.error('----------------------------------------------------------');
  console.error('ERRO: o arquivo .env não foi encontrado ou está incompleto.');
  console.error('Variáveis faltando:', missing.join(', '));
  console.error('Verifique se existe um arquivo chamado exatamente ".env"');
  console.error('(sem .txt no final) na mesma pasta do server.js.');
  console.error('No CMD, rode "dir /a" para conferir o nome real do arquivo.');
  console.error('----------------------------------------------------------');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: false,               // rede interna, sem TLS entre servidor e SQL Server
    trustServerCertificate: true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let poolPromise;
function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config).catch(err => {
      poolPromise = null; // permite tentar reconectar na próxima chamada
      throw err;
    });
  }
  return poolPromise;
}

// Lista fixa de testadores (a mesma usada no front-end)
const TESTERS = [
  "Moretti", "Balduino", "Marcio", "Carol", "Amanda",
  "Zanuto", "Matheus Estrella", "Mateus Cavalcante", "Guilherme", "Gabriel Adati"
];

app.get('/api/health', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1');
    res.json({ ok: true, db: 'conectado' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/testers', (req, res) => {
  res.json(TESTERS);
});

// Lista as atividades de um testador
app.get('/api/items', async (req, res) => {
  const { testador } = req.query;
  if (!testador) return res.status(400).json({ error: 'parâmetro testador é obrigatório' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('testador', sql.NVarChar, testador)
      .query('SELECT id, testador, codigo, tipo, modulo, cliente, status, status_em FROM dbo.TestesQA WHERE testador = @testador ORDER BY id');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria uma nova atividade
app.post('/api/items', async (req, res) => {
  const { testador, codigo, tipo, modulo, cliente } = req.body;
  if (!testador || !codigo || !tipo) {
    return res.status(400).json({ error: 'testador, codigo e tipo são obrigatórios' });
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('testador', sql.NVarChar, testador)
      .input('codigo', sql.NVarChar, codigo)
      .input('tipo', sql.NVarChar, tipo)
      .input('modulo', sql.NVarChar, modulo || null)
      .input('cliente', sql.NVarChar, cliente || null)
      .query(`INSERT INTO dbo.TestesQA (testador, codigo, tipo, modulo, cliente, status)
              VALUES (@testador, @codigo, @tipo, @modulo, @cliente, 'pendente')`);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'Este código já existe para este testador' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Atualiza o status de uma atividade (pendente | testando | baixado | recusado)
app.patch('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['pendente', 'testando', 'baixado', 'recusado'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'status inválido' });
  }
  try {
    const pool = await getPool();

    const current = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT testador, codigo, tipo FROM dbo.TestesQA WHERE id = @id');

    if (current.recordset.length === 0) {
      return res.status(404).json({ error: 'Atividade não encontrada' });
    }
    const { testador, codigo, tipo } = current.recordset[0];

    await pool.request()
      .input('id', sql.Int, id)
      .input('status', sql.NVarChar, status)
      .input('statusEm', sql.DateTime, (status === 'baixado' || status === 'recusado') ? new Date() : null)
      .query('UPDATE dbo.TestesQA SET status = @status, status_em = @statusEm WHERE id = @id');

    // Registra no histórico somente quando vira baixado ou recusado (testando é só visual)
    if (status === 'baixado' || status === 'recusado') {
      await pool.request()
        .input('testador', sql.NVarChar, testador)
        .input('codigo', sql.NVarChar, codigo)
        .input('tipo', sql.NVarChar, tipo)
        .input('status', sql.NVarChar, status)
        .query(`INSERT INTO dbo.TestesQAHistorico (testador, codigo, tipo, status)
                VALUES (@testador, @codigo, @tipo, @status)`);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico agrupado por testador, filtrando por data (e opcionalmente por testador)
app.get('/api/historico', async (req, res) => {
  const { data, testador } = req.query;
  if (!data) return res.status(400).json({ error: 'parâmetro data é obrigatório (YYYY-MM-DD)' });
  try {
    const pool = await getPool();
    const request = pool.request().input('data', sql.Date, data);
    let where = 'WHERE CAST(registrado_em AS DATE) = @data';
    if (testador && testador !== 'Todos') {
      request.input('testador', sql.NVarChar, testador);
      where += ' AND testador = @testador';
    }
    const result = await request.query(`
      SELECT testador,
             SUM(CASE WHEN status = 'baixado' THEN 1 ELSE 0 END) AS baixadas,
             SUM(CASE WHEN status = 'recusado' THEN 1 ELSE 0 END) AS recusas
      FROM dbo.TestesQAHistorico
      ${where}
      GROUP BY testador
      HAVING SUM(CASE WHEN status = 'baixado' THEN 1 ELSE 0 END) + SUM(CASE WHEN status = 'recusado' THEN 1 ELSE 0 END) > 0
      ORDER BY testador
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove uma atividade
app.delete('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.TestesQA WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
  console.log(`Teste em: http://localhost:${PORT}/api/health`);
});
