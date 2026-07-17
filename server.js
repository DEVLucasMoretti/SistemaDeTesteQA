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
    trustServerCertificate: true,
    useUTC: false                 // grava datas no horário local do servidor, evita registro "pular" de dia
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
      .query('SELECT id, testador, codigo, tipo, modulo, cliente, status, status_em, observacao FROM dbo.TestesQA WHERE testador = @testador ORDER BY id');
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

// Salva a observação de uma atividade da fila
app.patch('/api/items/:id/observacao', async (req, res) => {
  const { id } = req.params;
  const { observacao } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .input('observacao', sql.NVarChar, observacao || null)
      .query('UPDATE dbo.TestesQA SET observacao = @observacao WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
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
      .query('SELECT testador, codigo, tipo, status AS statusAtual FROM dbo.TestesQA WHERE id = @id');

    if (current.recordset.length === 0) {
      return res.status(404).json({ error: 'Atividade não encontrada' });
    }
    const { testador, codigo, tipo, statusAtual } = current.recordset[0];
    const mudouStatus = statusAtual !== status;

    await pool.request()
      .input('id', sql.Int, id)
      .input('status', sql.NVarChar, status)
      .input('statusEm', sql.DateTime, (status === 'baixado' || status === 'recusado') ? new Date() : null)
      .query('UPDATE dbo.TestesQA SET status = @status, status_em = @statusEm WHERE id = @id');

    // Registra no histórico apenas em transições reais para baixado/recusado,
    // e no máximo uma vez por dia por atividade+status (evita contar a mesma baixa/recusa várias vezes)
    if (mudouStatus && (status === 'baixado' || status === 'recusado')) {
      const dup = await pool.request()
        .input('testador', sql.NVarChar, testador)
        .input('codigo', sql.NVarChar, codigo)
        .input('status', sql.NVarChar, status)
        .query(`SELECT TOP 1 id FROM dbo.TestesQAHistorico
                WHERE testador = @testador AND codigo = @codigo AND status = @status
                  AND CAST(registrado_em AS DATE) = CAST(GETDATE() AS DATE)`);

      if (dup.recordset.length === 0) {
        await pool.request()
          .input('testador', sql.NVarChar, testador)
          .input('codigo', sql.NVarChar, codigo)
          .input('tipo', sql.NVarChar, tipo)
          .input('status', sql.NVarChar, status)
          .query(`INSERT INTO dbo.TestesQAHistorico (testador, codigo, tipo, status)
                  VALUES (@testador, @codigo, @tipo, @status)`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resumo do dia por tipo, baseado no HISTÓRICO (não muda se o item voltar para a fila depois)
app.get('/api/historico/resumo', async (req, res) => {
  const { data, testador } = req.query;
  if (!data || !testador) return res.status(400).json({ error: 'parâmetros data e testador são obrigatórios' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('data', sql.VarChar, data)
      .input('testador', sql.NVarChar, testador)
      .query(`
        SELECT tipo,
               SUM(CASE WHEN status = 'baixado' THEN 1 ELSE 0 END) AS baixados,
               SUM(CASE WHEN status = 'recusado' THEN 1 ELSE 0 END) AS recusados
        FROM dbo.TestesQAHistorico
        WHERE testador = @testador AND CAST(registrado_em AS DATE) = @data
        GROUP BY tipo
      `);
    const porTipo = result.recordset;
    const totalBaixados = porTipo.reduce((s, r) => s + r.baixados, 0);
    const totalRecusados = porTipo.reduce((s, r) => s + r.recusados, 0);
    res.json({ porTipo, totalBaixados, totalRecusados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Desfaz uma baixa feita sem querer: volta pra fila E remove do histórico de hoje
// (diferente de uma recusa devolvida à fila, que continua contando no relatório)
app.post('/api/items/:id/desfazer-baixa', async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();

    const current = await pool.request()
      .input('id', sql.Int, id)
      .query("SELECT testador, codigo, status FROM dbo.TestesQA WHERE id = @id");

    if (current.recordset.length === 0) {
      return res.status(404).json({ error: 'Atividade não encontrada' });
    }
    const { testador, codigo, status } = current.recordset[0];
    if (status !== 'baixado') {
      return res.status(400).json({ error: 'Esta atividade não está com status baixado' });
    }

    await pool.request()
      .input('id', sql.Int, id)
      .query("UPDATE dbo.TestesQA SET status = 'pendente', status_em = NULL WHERE id = @id");

    await pool.request()
      .input('testador', sql.NVarChar, testador)
      .input('codigo', sql.NVarChar, codigo)
      .query(`DELETE FROM dbo.TestesQAHistorico
              WHERE testador = @testador AND codigo = @codigo AND status = 'baixado'
                AND CAST(registrado_em AS DATE) = CAST(GETDATE() AS DATE)`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico discriminado (linha a linha), filtrando por testador, tipo/status e intervalo de datas
// Se "situacao" for informado, a data é ignorada (mostra todas as datas com aquela situação)
app.get('/api/historico/detalhado', async (req, res) => {
  const { testador, filtro, dataInicio, dataFim, situacao } = req.query;
  try {
    const pool = await getPool();
    const request = pool.request();
    let where = 'WHERE 1=1';

    if (testador && testador !== 'Todos') {
      request.input('testador', sql.NVarChar, testador);
      where += ' AND testador = @testador';
    }
    if (filtro === 'baixa') {
      where += " AND status = 'baixado'";
    } else if (filtro === 'recusa') {
      where += " AND status = 'recusado'";
    } else if (filtro === 'alteracao') {
      request.input('tipoAlteracao', sql.NVarChar, 'Alteração');
      where += ' AND tipo = @tipoAlteracao';
    }

    if (situacao) {
      // Filtrando por situação: não considera data
      request.input('situacao', sql.NVarChar, situacao);
      where += ' AND situacao = @situacao';
    } else if (dataInicio && dataFim) {
      request.input('dataInicio', sql.VarChar, dataInicio);
      request.input('dataFim', sql.VarChar, dataFim);
      where += ' AND CAST(registrado_em AS DATE) BETWEEN @dataInicio AND @dataFim';
    }

    const result = await request.query(`
      SELECT id, testador, codigo, tipo, status, registrado_em, observacao, situacao
      FROM dbo.TestesQAHistorico
      ${where}
      ORDER BY registrado_em DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Salva/edita a observação e/ou situação de uma linha do histórico
app.patch('/api/historico/:id', async (req, res) => {
  const { id } = req.params;
  const { observacao, situacao } = req.body;
  try {
    const pool = await getPool();
    const sets = [];
    const request = pool.request().input('id', sql.Int, id);

    if (observacao !== undefined) {
      request.input('observacao', sql.NVarChar, observacao || null);
      sets.push('observacao = @observacao');
    }
    if (situacao !== undefined) {
      request.input('situacao', sql.NVarChar, situacao);
      sets.push('situacao = @situacao');
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });

    await request.query(`UPDATE dbo.TestesQAHistorico SET ${sets.join(', ')} WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Itens baixados ou recusados HOJE por um testador (grades que resetam no dia seguinte)
app.get('/api/items/hoje', async (req, res) => {
  const { testador, status } = req.query;
  if (!testador || !['baixado', 'recusado'].includes(status)) {
    return res.status(400).json({ error: 'parâmetros testador e status (baixado|recusado) são obrigatórios' });
  }
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('testador', sql.NVarChar, testador)
      .input('status', sql.NVarChar, status)
      .query(`SELECT id, codigo, tipo, modulo, cliente, status, status_em, observacao
              FROM dbo.TestesQA
              WHERE testador = @testador AND status = @status
                AND CAST(status_em AS DATE) = CAST(GETDATE() AS DATE)
              ORDER BY status_em DESC`);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico agrupado por testador, filtrando por intervalo de datas (e opcionalmente por testador)
app.get('/api/historico', async (req, res) => {
  const { dataInicio, dataFim, testador } = req.query;
  if (!dataInicio || !dataFim) return res.status(400).json({ error: 'parâmetros dataInicio e dataFim são obrigatórios (YYYY-MM-DD)' });
  try {
    const pool = await getPool();
    const request = pool.request()
      .input('dataInicio', sql.VarChar, dataInicio)
      .input('dataFim', sql.VarChar, dataFim);
    let where = 'WHERE CAST(registrado_em AS DATE) BETWEEN @dataInicio AND @dataFim';
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
