// Este script REGISTRA a API como um Serviço do Windows.
// Rode ele UMA VEZ (como Administrador). Depois disso, a API roda em
// segundo plano sozinha, sem terminal aberto, e sobe automaticamente
// toda vez que o Windows ligar.

const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'ProgressoCorrecoesAPI',
  description: 'API que conecta o painel de Progresso de Correções ao SQL Server (130_QA)',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: [],
  workingDirectory: __dirname
});

svc.on('install', () => {
  console.log('Serviço instalado com sucesso. Iniciando...');
  svc.start();
});

svc.on('start', () => {
  console.log('Serviço "ProgressoCorrecoesAPI" iniciado.');
  console.log('Ele já está rodando em segundo plano — pode fechar este terminal.');
  console.log('Confira em: http://localhost:3001/api/health');
});

svc.on('alreadyinstalled', () => {
  console.log('O serviço já estava instalado.');
});

svc.on('error', (err) => {
  console.error('Erro ao instalar/iniciar o serviço:', err);
});

svc.install();
