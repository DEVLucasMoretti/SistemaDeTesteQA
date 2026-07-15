// Use este script se precisar REMOVER o serviço (por exemplo, pra reinstalar
// depois de alguma mudança no server.js). Rode como Administrador.

const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'ProgressoCorrecoesAPI',
  script: path.join(__dirname, 'server.js')
});

svc.on('uninstall', () => {
  console.log('Serviço removido com sucesso.');
});

svc.uninstall();
