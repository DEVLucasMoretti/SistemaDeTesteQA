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
        status      NVARCHAR(20)  NOT NULL DEFAULT 'pendente', -- pendente | baixado | recusado
        status_em   DATETIME      NULL,
        criado_em   DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_testador_codigo UNIQUE (testador, codigo)
    );
END
GO
