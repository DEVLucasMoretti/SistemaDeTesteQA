-- Execute este script UMA VEZ no banco 130_QA (via SSMS, conectado com o usuário sa)
-- Cria a tabela que vai guardar as atividades de cada testador

USE [130_QA];
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TestesQA')
BEGIN
    CREATE TABLE dbo.TestesQA (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        testador    NVARCHAR(50)  NOT NULL,
        codigo      NVARCHAR(30)  NOT NULL,
        tipo        NVARCHAR(30)  NOT NULL,
        modulo      NVARCHAR(50)  NULL,
        cliente     NVARCHAR(150) NULL,
        status      NVARCHAR(20)  NOT NULL DEFAULT 'pendente', -- pendente | testando | baixado | recusado
        status_em   DATETIME      NULL,
        criado_em   DATETIME      NOT NULL DEFAULT GETDATE(),
        observacao  NVARCHAR(1000) NULL,
        CONSTRAINT UQ_testador_codigo UNIQUE (testador, codigo)
    );
END
GO

-- Caso a tabela já exista de uma versão anterior, garante que a coluna de observação existe
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = 'observacao' AND Object_ID = Object_ID('dbo.TestesQA'))
BEGIN
    ALTER TABLE dbo.TestesQA ADD observacao NVARCHAR(1000) NULL;
END
GO

-- Tabela auxiliar: registra cada baixa/recusa (histórico, nunca é apagada)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TestesQAHistorico')
BEGIN
    CREATE TABLE dbo.TestesQAHistorico (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        testador      NVARCHAR(50)  NOT NULL,
        codigo        NVARCHAR(30)  NOT NULL,
        tipo          NVARCHAR(30)  NULL,
        status        NVARCHAR(20)  NOT NULL, -- baixado | recusado
        registrado_em DATETIME      NOT NULL DEFAULT GETDATE(),
        observacao    NVARCHAR(500) NULL
    );
    CREATE INDEX IX_historico_data ON dbo.TestesQAHistorico (registrado_em);
    CREATE INDEX IX_historico_testador ON dbo.TestesQAHistorico (testador);
END
GO

-- Caso a tabela já exista de uma versão anterior, garante que a coluna de observação existe
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = 'observacao' AND Object_ID = Object_ID('dbo.TestesQAHistorico'))
BEGIN
    ALTER TABLE dbo.TestesQAHistorico ADD observacao NVARCHAR(500) NULL;
END
GO

-- Coluna de Situação (Padrão | Com Programador | Buildando Pipeline | Esperando Análise)
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = 'situacao' AND Object_ID = Object_ID('dbo.TestesQAHistorico'))
BEGIN
    ALTER TABLE dbo.TestesQAHistorico ADD situacao NVARCHAR(30) NOT NULL DEFAULT 'Padrão';
END
GO
